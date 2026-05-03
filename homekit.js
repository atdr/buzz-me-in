'use strict';

/**
 * HAP-NodeJS camera+doorbell accessory for the apartment intercom.
 *
 * Requires hap-nodejs >= 12.x and ffmpeg with libopus (libx264 for video).
 *
 * Inbound path (Twilio → HomeKit):
 *   raw mulaw/8kHz on PassThrough stdin
 *   → ffmpeg: decode mulaw, encode Opus; mux blank H.264 video
 *   → SRTP to HomeKit
 *
 * Outbound path (HomeKit → Twilio):
 *   SRTP return audio from iPhone → local UDP port
 *   → ffmpeg: decrypt, decode Opus, encode mulaw/8kHz
 *   → stdout → Node.js → Twilio WebSocket JSON envelope
 */

const hap = require('hap-nodejs');
const qrcode = require('qrcode-terminal');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');

const config = require('./src/core/config');
const state = require('./src/core/state');
const { sendDtmfSequence, sendMulawAudio } = require('./src/core/mulaw-audio');
const { createLogger } = require('./src/core/log');
const { hangUpCall } = require('./twilio-api');

const {
  Accessory,
  Service,
  Characteristic,
  uuid: hapUuid,
  CameraController,
  SRTPCryptoSuites,
  H264Profile,
  H264Level,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  StreamRequestTypes,
  Categories,
} = hap;
const logger = createLogger({ component: 'homekit' });

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getLocalIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

/** Bind a random OS-assigned port then immediately release it. */
function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.listen(0, '0.0.0.0', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to allocate ephemeral port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function randomSSRC() {
  // ffmpeg's RTP muxer parses -ssrc as a signed 32-bit integer option.
  return crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff;
}

/**
 * ffmpeg -srtp_out_params expects the SRTP master key and salt
 * concatenated and base64-encoded (16-byte key + 14-byte salt = 30 bytes).
 */
function srtpParams(key, salt) {
  return Buffer.concat([key, salt]).toString('base64');
}

// ---------------------------------------------------------------------------
// Minimal 1×1 black JPEG used for snapshot responses.
// Generated once at startup by ffmpeg; falls back to a hardcoded buffer.
// ---------------------------------------------------------------------------

let snapshotJpeg = null;

function initSnapshot() {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'color=black:s=1280x720',
      '-vframes',
      '1',
      '-f',
      'mjpeg',
      '-q:v',
      '5',
      'pipe:1',
    ]);
    const chunks = [];
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stdout.on('end', () => {
      snapshotJpeg = chunks.length ? Buffer.concat(chunks) : FALLBACK_JPEG;
      resolve();
    });
    ff.on('error', () => {
      snapshotJpeg = FALLBACK_JPEG;
      resolve();
    });
    ff.stderr.resume(); // discard
  });
}

// Hardcoded 1×1 black JPEG (used only if ffmpeg isn't available at init time)
const FALLBACK_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDB' +
    'kSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAAR' +
    'CAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAA' +
    'AAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAA' +
    'AAAAAA/9oADAMBAAIRAxEAPwClAAH/2Q==',
  'base64'
);

// ---------------------------------------------------------------------------
// Active HAP streaming sessions
// ---------------------------------------------------------------------------

/**
 * Map from sessionID → {
 *   targetAddress, hkVideoPort, hkVideoKey, hkVideoSalt,
 *   hkAudioPort, hkAudioKey, hkAudioSalt,
 *   returnAudioPort, returnAudioKey, returnAudioSalt,
 *   ffIn, ffOut, sdpPath  ← added on START
 * }
 */
const activeSessions = new Map();

// PassThrough stream set by server.js each time a Twilio call connects.
let currentMulawStream = null;
let onHapSessionStarted = null;

function getActiveCall() {
  return state.getActiveCall();
}

function attachMulawStreamToSession(sessionID, stream) {
  const session = activeSessions.get(sessionID);
  if (!session || !stream || !session.ffIn || !session.ffIn.stdin || session.ffIn.stdin.destroyed) {
    return false;
  }
  if (session.mulawStream && session.mulawStream !== stream) {
    try {
      session.mulawStream.unpipe(session.ffIn.stdin);
    } catch {}
  }
  session.mulawStream = stream;
  stream.pipe(session.ffIn.stdin, { end: false });
  logger.info('Bound mulaw stream to active HomeKit session', {
    event: 'mulaw-stream-bound',
    sessionId: sessionID,
  });
  return true;
}

async function prepareStreamSession(request) {
  const returnAudioPort = await getAvailablePort();
  const videoSsrc = randomSSRC();
  const audioSsrc = randomSSRC();

  // getAvailablePort() for our "video receive" slot -- we never actually
  // receive video from HomeKit, but HAP requires us to declare a port.
  const dummyVideoPort = await getAvailablePort();

  activeSessions.set(request.sessionID, {
    targetAddress: request.targetAddress,
    hkVideoPort: request.video.port,
    hkVideoKey: request.video.srtp_key,
    hkVideoSalt: request.video.srtp_salt,
    hkAudioPort: request.audio.port,
    hkAudioKey: request.audio.srtp_key,
    hkAudioSalt: request.audio.srtp_salt,
    returnAudioPort,
    returnAudioKey: request.audio.srtp_key,
    returnAudioSalt: request.audio.srtp_salt,
    videoSsrc,
    audioSsrc,
  });

  return {
    address: { address: getLocalIp(), type: 'v4' },
    video: {
      port: dummyVideoPort,
      ssrc: videoSsrc,
      srtp_key: request.video.srtp_key,
      srtp_salt: request.video.srtp_salt,
    },
    audio: {
      port: returnAudioPort,
      ssrc: audioSsrc,
      srtp_key: request.audio.srtp_key,
      srtp_salt: request.audio.srtp_salt,
    },
  };
}

// ---------------------------------------------------------------------------
// Camera streaming delegate
// ---------------------------------------------------------------------------

const streamingDelegate = {
  handleSnapshotRequest(_req, callback) {
    callback(undefined, snapshotJpeg || FALLBACK_JPEG);
  },

  prepareStream(request, callback) {
    prepareStreamSession(request)
      .then((response) => callback(undefined, response))
      .catch((error) => {
        logger.error('Failed to prepare HomeKit stream', {
          event: 'stream-prepare-failed',
          reason: 'prepare-error',
          sessionId: request.sessionID,
          error,
        });
        callback(error);
      });
  },

  handleStreamRequest(request, callback) {
    const s = activeSessions.get(request.sessionID);
    if (!s) {
      callback();
      return;
    }

    if (request.type === StreamRequestTypes.START) {
      _startSession(request.sessionID, s, request, callback);
    } else if (request.type === StreamRequestTypes.RECONFIGURE) {
      // Static source — ignore bitrate/resolution change requests.
      callback();
    } else if (request.type === StreamRequestTypes.STOP) {
      _stopSession(request.sessionID, /* hangUp= */ true);
      callback();
    }
  },
};

// ---------------------------------------------------------------------------
// Session start: spawn inbound and outbound ffmpeg processes
// ---------------------------------------------------------------------------

function _startSession(sessionID, s, request, callback) {
  const videoParams = srtpParams(s.hkVideoKey, s.hkVideoSalt);
  const audioParams = srtpParams(s.hkAudioKey, s.hkAudioSalt);
  const video = request.video;
  const audio = request.audio;
  const videoBitrate = Math.max(64, video.max_bit_rate || 200);
  const videoBufferSize = Math.max(videoBitrate * 2, 128);
  const mtu = video.mtu || 1316;

  // -------------------------------------------------------------------------
  // Inbound ffmpeg
  //
  // Input 0  – raw mulaw/8kHz from Twilio via stdin
  //   Let the raw audio demuxer derive PTS from sample count. Using wall-clock
  //   timestamps breaks when ffmpeg drains the buffered startup audio burst.
  //
  // Input 1  – synthetic black video (lavfi color source)
  //   Generates H.264 Baseline/3.1 frames at 15 fps.
  //   HomeKit requires a video track; there is no real camera feed.
  //   keyint_min=15 / -g 15 forces an IDR frame every second — HomeKit
  //   requests it when the live view is first opened; without frequent IDRs
  //   the video stays blank until the next natural keyframe.
  //
  // Two separate SRTP outputs — no muxing, no pts coupling between streams.
  // -------------------------------------------------------------------------
  const ffIn = spawn('ffmpeg', [
    '-y',
    '-loglevel',
    'warning',

    // ---- Input 0: raw mulaw from Twilio ----
    '-thread_queue_size',
    '512',
    '-f',
    'mulaw',
    '-ar',
    '8000',
    '-ac',
    '1',
    '-i',
    'pipe:0',

    // ---- Input 1: blank video ----
    '-f',
    'lavfi',
    '-i',
    'color=black:s=1280x720:r=15',

    // ---- Video output → HomeKit SRTP ----
    '-map',
    '1:v',
    '-c:v',
    'libx264',
    '-profile:v',
    'baseline',
    '-level:v',
    '3.1',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    `${videoBitrate}k`,
    '-maxrate',
    `${videoBitrate}k`,
    '-bufsize',
    `${videoBufferSize}k`,
    '-g',
    String(video.fps || 15),
    '-keyint_min',
    String(video.fps || 15),
    '-payload_type',
    String(video.pt),
    '-ssrc',
    String(s.videoSsrc),
    '-f',
    'rtp',
    '-srtp_out_suite',
    'AES_CM_128_HMAC_SHA1_80',
    '-srtp_out_params',
    videoParams,
    `srtp://${s.targetAddress}:${s.hkVideoPort}?rtcpport=${s.hkVideoPort}&localrtcpport=${s.hkVideoPort}&pkt_size=${mtu}`,

    // ---- Audio output → HomeKit SRTP (Opus/16kHz) ----
    //
    // Note on codec choice: libopus is in every standard ffmpeg build.
    // If you prefer AAC-ELD (required by some older HomeKit devices), compile
    // ffmpeg with --enable-libfdk-aac --enable-nonfree and change:
    //   '-c:a', 'libfdk_aac', '-profile:a', 'aac_eld',
    // and update streamingOptions.audio.codecs below to AAC_ELD.
    '-map',
    '0:a',
    '-c:a',
    'libopus',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-b:a',
    '24k',
    '-application',
    'voip',
    '-frame_duration',
    '20',
    '-payload_type',
    String(audio.pt),
    '-ssrc',
    String(s.audioSsrc),
    '-f',
    'rtp',
    '-srtp_out_suite',
    'AES_CM_128_HMAC_SHA1_80',
    '-srtp_out_params',
    audioParams,
    `srtp://${s.targetAddress}:${s.hkAudioPort}?rtcpport=${s.hkAudioPort}&localrtcpport=${s.hkAudioPort}`,
  ]);

  ffIn.stderr.on('data', (d) => {
    logger.warn('Inbound ffmpeg stderr', {
      event: 'ffin-stderr',
      reason: 'ffmpeg-stderr',
      detail: d.toString('utf8').trim(),
      sessionId: sessionID,
    });
  });
  ffIn.on('close', (code) => {
    logger.info('Inbound ffmpeg exited', {
      event: 'ffin-exit',
      reason: code === 0 ? 'clean-exit' : 'nonzero-exit',
      exitCode: code,
      sessionId: sessionID,
    });
  });
  ffIn.stdin.on('error', () => {}); // suppress EPIPE when stream ends

  // -------------------------------------------------------------------------
  // Outbound ffmpeg
  //
  // iPhone → SRTP → returnAudioPort → ffmpeg (Opus decode + mulaw encode)
  //        → stdout → Node.js → Twilio WebSocket JSON envelope
  //
  // The SDP file tells ffmpeg how to receive and decrypt the SRTP stream.
  //
  // Use the negotiated Opus payload type from HomeKit's START request; older
  // versions assumed 110, which breaks when the controller chooses otherwise.
  // -------------------------------------------------------------------------
  const returnParams = srtpParams(s.returnAudioKey, s.returnAudioSalt);
  const sdpPath = `/tmp/intercom_return_${sessionID}.sdp`;

  fs.writeFileSync(
    sdpPath,
    [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=Return Audio',
      'c=IN IP4 127.0.0.1',
      't=0 0',
      `m=audio ${s.returnAudioPort} RTP/SAVP ${audio.pt}`,
      `a=rtpmap:${audio.pt} opus/48000/2`,
      `a=fmtp:${audio.pt} minptime=10;useinbandfec=1`,
      `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${returnParams}`,
      'a=recvonly',
      '',
    ].join('\r\n')
  );

  const ffOut = spawn('ffmpeg', [
    '-y',
    '-loglevel',
    'warning',
    '-protocol_whitelist',
    'file,crypto,udp,rtp',
    '-f',
    'sdp',
    '-i',
    sdpPath,
    // Decode Opus → resample → encode mulaw/8kHz
    '-ar',
    '8000',
    '-ac',
    '1',
    '-c:a',
    'pcm_mulaw',
    '-f',
    'mulaw',
    '-fflags',
    '+nobuffer',
    '-flush_packets',
    '1',
    'pipe:1',
  ]);

  ffOut.stderr.on('data', (d) => {
    logger.warn('Outbound ffmpeg stderr', {
      event: 'ffout-stderr',
      reason: 'ffmpeg-stderr',
      detail: d.toString('utf8').trim(),
      sessionId: sessionID,
    });
  });
  ffOut.on('close', (code) => {
    logger.info('Outbound ffmpeg exited', {
      event: 'ffout-exit',
      reason: code === 0 ? 'clean-exit' : 'nonzero-exit',
      exitCode: code,
      sessionId: sessionID,
    });
  });

  // Forward each decoded mulaw chunk to Twilio as a media event.
  ffOut.stdout.on('data', (chunk) => {
    const activeCall = getActiveCall();
    if (!activeCall || !activeCall.wsConnection || !activeCall.streamSid) return;
    const connection = /** @type {{ dropHomekitOutbound?: boolean }} */ (activeCall.wsConnection);
    if (connection.dropHomekitOutbound) return;
    sendMulawAudio(activeCall, chunk, { source: 'homekit' });
    state.markActivity(activeCall.callSid, 'homekit-outbound-media');
  });

  activeSessions.set(sessionID, { ...s, ffIn, ffOut, sdpPath });
  attachMulawStreamToSession(sessionID, currentMulawStream);

  const activeCall = getActiveCall();
  if (activeCall && onHapSessionStarted) {
    onHapSessionStarted(activeCall.callSid);
  }

  callback();
}

// ---------------------------------------------------------------------------
// Session stop: tear down ffmpeg, optionally hang up Twilio call
// ---------------------------------------------------------------------------

function _stopSession(sessionID, hangUp) {
  const s = activeSessions.get(sessionID);
  if (!s) return;
  activeSessions.delete(sessionID);

  if (s.ffIn) {
    if (s.mulawStream || currentMulawStream) {
      try {
        (s.mulawStream || currentMulawStream).unpipe(s.ffIn.stdin);
      } catch {}
    }
    s.ffIn.kill('SIGINT');
  }
  if (s.ffOut) s.ffOut.kill('SIGINT');
  if (s.sdpPath) {
    try {
      fs.unlinkSync(s.sdpPath);
    } catch {}
  }

  const activeCall = getActiveCall();
  if (hangUp && activeCall) {
    hangUpCall(activeCall.callSid)
      .then((result) => {
        if (result && result.alreadyEnded) {
          logger.info('Twilio call already ended while stopping HomeKit session', {
            event: 'hangup-call-already-ended',
            reason: 'twilio-call-not-in-progress',
            callSid: activeCall.callSid,
            sessionId: sessionID,
          });
        }
      })
      .catch((error) => {
        logger.error('Failed to hang up call while stopping HomeKit session', {
          event: 'hangup-call-failed',
          reason: 'twilio-hangup-failed',
          callSid: activeCall.callSid,
          sessionId: sessionID,
          error,
        });
      });
  }
}

// ---------------------------------------------------------------------------
// Accessory construction
// ---------------------------------------------------------------------------

const accessory = new Accessory('Apartment Intercom', hapUuid.generate('homekit-intercom-v1'));

accessory
  .getService(Service.AccessoryInformation)
  .setCharacteristic(Characteristic.Manufacturer, 'DIY')
  .setCharacteristic(Characteristic.Model, 'RPi Intercom')
  .setCharacteristic(Characteristic.SerialNumber, 'RPI-001');

// ---- Doorbell ----
const doorbellService = accessory.addService(Service.Doorbell, 'Intercom Doorbell');

// ---- Lock (triggers DTMF unlock) ----
const lockService = accessory.addService(Service.LockMechanism, 'Intercom Lock');
lockService
  .getCharacteristic(Characteristic.LockCurrentState)
  .onGet(() => Characteristic.LockCurrentState.SECURED)
  .setValue(Characteristic.LockCurrentState.SECURED);

lockService
  .getCharacteristic(Characteristic.LockTargetState)
  .onGet(() => Characteristic.LockTargetState.SECURED)
  .onSet(async (value) => {
    const activeCall = getActiveCall();
    if (value === Characteristic.LockTargetState.UNSECURED && activeCall) {
      try {
        await sendDtmfSequence(activeCall, config.twilioUnlockDigits);
        state.markActivity(activeCall.callSid, 'unlock-dtmf');
        logger.info('Sent DTMF unlock over active media stream', {
          event: 'unlock-requested',
          callSid: activeCall.callSid,
          digits: config.twilioUnlockDigits,
        });
      } catch (error) {
        logger.error('Unlock door request failed', {
          event: 'unlock-failed',
          reason: 'dtmf-send-failed',
          callSid: activeCall.callSid,
          error,
        });
      }
      // Reset the lock tile to Secured after 3 s so it's ready for next use.
      setTimeout(() => {
        lockService
          .getCharacteristic(Characteristic.LockCurrentState)
          .updateValue(Characteristic.LockCurrentState.SECURED);
        lockService
          .getCharacteristic(Characteristic.LockTargetState)
          .updateValue(Characteristic.LockTargetState.SECURED);
      }, 3000);
    } else if (value === Characteristic.LockTargetState.UNSECURED) {
      logger.warn('Unlock requested but no active call', {
        event: 'unlock-no-active-call',
        reason: 'no-active-call',
      });
      setTimeout(() => {
        lockService
          .getCharacteristic(Characteristic.LockTargetState)
          .updateValue(Characteristic.LockTargetState.SECURED);
      }, 500);
    }
  });

// ---- Camera controller ----
const cameraController = new CameraController({
  cameraStreamCount: 2,
  delegate: streamingDelegate,
  streamingOptions: {
    supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
    video: {
      resolutions: [
        [1280, 720, 15],
        [640, 360, 15],
        [320, 240, 15],
      ],
      codec: {
        profiles: [H264Profile.BASELINE],
        levels: [H264Level.LEVEL3_1],
      },
    },
    audio: {
      twoWayAudio: true,
      codecs: [
        {
          type: AudioStreamingCodecType.OPUS,
          samplerate: AudioStreamingSamplerate.KHZ_16,
        },
      ],
    },
  },
});

accessory.configureController(cameraController);

accessory.publish({
  username: config.hapUsername,
  pincode: config.hapPincode,
  port: config.hapPort,
  category: Categories.VIDEO_DOORBELL,
  advertiser: hap.MDNSAdvertiser.AVAHI,
});

const hapPincode = config.hapPincode;
logger.info('Accessory published', {
  event: 'accessory-published',
  hapPincode,
});
logger.info('Accessory QR setup URI generated', {
  event: 'accessory-qr-setup',
});
qrcode.generate(accessory.setupURI(), { small: true });

// Kick off snapshot generation asynchronously (non-blocking)
initSnapshot().then(() =>
  logger.info('Snapshot initialized', {
    event: 'snapshot-ready',
  })
);

// ---------------------------------------------------------------------------
// Exports called by server.js
// ---------------------------------------------------------------------------

/**
 * Ring the HomeKit doorbell.
 * Called when the Twilio WebSocket fires the 'start' event.
 */
function triggerDoorbell() {
  doorbellService.getCharacteristic(Characteristic.ProgrammableSwitchEvent).updateValue(0); // 0 = SINGLE_PRESS
  logger.info('Doorbell triggered', {
    event: 'doorbell-triggered',
  });
}

/**
 * Set (or replace) the PassThrough stream that delivers mulaw bytes.
 * Called at the start of each new Twilio call.
 */
function setMulawPassthrough(stream) {
  currentMulawStream = stream;
  let reboundCount = 0;
  for (const [sessionID, session] of activeSessions.entries()) {
    if (!session.ffIn || !session.ffIn.stdin || session.ffIn.stdin.destroyed) continue;
    if (!attachMulawStreamToSession(sessionID, stream)) continue;
    reboundCount++;
    logger.info('Rebound mulaw stream to active HomeKit session', {
      event: 'mulaw-stream-rebound',
      sessionId: sessionID,
    });
  }
  return reboundCount;
}

/**
 * Force-close all active HAP sessions.
 * Called when Twilio fires the 'stop' event (caller hung up).
 * Does NOT call hangUpCall — the call is already gone.
 */
function endHapSession() {
  for (const sessionID of activeSessions.keys()) {
    _stopSession(sessionID, /* hangUp= */ false);
  }
}

function setOnHapSessionStarted(handler) {
  onHapSessionStarted = typeof handler === 'function' ? handler : null;
}

module.exports = {
  triggerDoorbell,
  setMulawPassthrough,
  endHapSession,
  setOnHapSessionStarted,
};
