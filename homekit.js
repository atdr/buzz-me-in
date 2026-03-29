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
const fs     = require('fs');
const net    = require('net');
const os     = require('os');
const { spawn } = require('child_process');

const state           = require('./state');
const { hangUpCall, unlockDoor } = require('./twilio-api');

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
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function randomSSRC() {
  return crypto.randomBytes(4).readUInt32BE(0);
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
      '-f', 'lavfi', '-i', 'color=black:s=1280x720',
      '-vframes', '1', '-f', 'mjpeg', '-q:v', '5', 'pipe:1',
    ]);
    const chunks = [];
    ff.stdout.on('data', d => chunks.push(d));
    ff.stdout.on('end', () => {
      snapshotJpeg = chunks.length ? Buffer.concat(chunks) : FALLBACK_JPEG;
      resolve();
    });
    ff.on('error', () => { snapshotJpeg = FALLBACK_JPEG; resolve(); });
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

// ---------------------------------------------------------------------------
// Camera streaming delegate
// ---------------------------------------------------------------------------

const streamingDelegate = {

  handleSnapshotRequest(_req, callback) {
    callback(undefined, snapshotJpeg || FALLBACK_JPEG);
  },

  async prepareStream(request, callback) {
    const returnAudioPort = await getAvailablePort();
    const returnAudioKey  = crypto.randomBytes(16);
    const returnAudioSalt = crypto.randomBytes(14);

    // getAvailablePort() for our "video receive" slot — we never actually
    // receive video from HomeKit, but HAP requires us to declare a port.
    const dummyVideoPort = await getAvailablePort();

    activeSessions.set(request.sessionID, {
      targetAddress:    request.targetAddress,
      hkVideoPort:      request.video.port,
      hkVideoKey:       request.video.srtp_key,
      hkVideoSalt:      request.video.srtp_salt,
      hkAudioPort:      request.audio.port,
      hkAudioKey:       request.audio.srtp_key,
      hkAudioSalt:      request.audio.srtp_salt,
      returnAudioPort,
      returnAudioKey,
      returnAudioSalt,
    });

    callback({
      address: { address: getLocalIp(), type: 'v4' },
      video: {
        port:      dummyVideoPort,
        ssrc:      randomSSRC(),
        srtp_key:  crypto.randomBytes(16),
        srtp_salt: crypto.randomBytes(14),
      },
      audio: {
        port:      returnAudioPort,
        ssrc:      randomSSRC(),
        srtp_key:  returnAudioKey,
        srtp_salt: returnAudioSalt,
      },
    });
  },

  handleStreamRequest(request, callback) {
    const s = activeSessions.get(request.sessionID);
    if (!s) { callback(); return; }

    if (request.type === StreamRequestTypes.START) {
      _startSession(request.sessionID, s, callback);

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

function _startSession(sessionID, s, callback) {
  const videoParams = srtpParams(s.hkVideoKey,  s.hkVideoSalt);
  const audioParams = srtpParams(s.hkAudioKey,  s.hkAudioSalt);

  // -------------------------------------------------------------------------
  // Inbound ffmpeg
  //
  // Input 0  – raw mulaw/8kHz from Twilio via stdin
  //   -use_wallclock_as_timestamps 1
  //     Timestamps from wall clock, not accumulated byte count.
  //     Without this, any jitter in Twilio packet delivery causes pts drift
  //     that eventually makes ffmpeg drop or duplicate audio frames.
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
    '-y', '-loglevel', 'warning',

    // ---- Input 0: raw mulaw from Twilio ----
    '-use_wallclock_as_timestamps', '1',
    '-f', 'mulaw', '-ar', '8000', '-ac', '1',
    '-i', 'pipe:0',

    // ---- Input 1: blank video ----
    '-f', 'lavfi',
    '-i', 'color=black:s=1280x720:r=15',

    // ---- Video output → HomeKit SRTP ----
    '-map', '1:v',
    '-c:v', 'libx264',
    '-profile:v', 'baseline', '-level:v', '3.1',
    '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-b:v', '200k', '-maxrate', '200k', '-bufsize', '400k',
    '-g', '15', '-keyint_min', '15',
    '-f', 'rtp',
    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
    '-srtp_out_params', videoParams,
    `srtp://${s.targetAddress}:${s.hkVideoPort}?rtcpport=${s.hkVideoPort + 1}`,

    // ---- Audio output → HomeKit SRTP (Opus/16kHz) ----
    //
    // Note on codec choice: libopus is in every standard ffmpeg build.
    // If you prefer AAC-ELD (required by some older HomeKit devices), compile
    // ffmpeg with --enable-libfdk-aac --enable-nonfree and change:
    //   '-c:a', 'libfdk_aac', '-profile:a', 'aac_eld',
    // and update streamingOptions.audio.codecs below to AAC_ELD.
    '-map', '0:a',
    '-c:a', 'libopus',
    '-ar', '16000', '-ac', '1', '-b:a', '24k',
    '-application', 'voip',
    '-frame_duration', '20',
    '-f', 'rtp',
    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
    '-srtp_out_params', audioParams,
    `srtp://${s.targetAddress}:${s.hkAudioPort}?rtcpport=${s.hkAudioPort + 1}`,
  ]);

  ffIn.stderr.on('data', d => process.stderr.write('[ffIn] ' + d));
  ffIn.on('close', code => console.log('[ffIn] exited', code));
  ffIn.stdin.on('error', () => {}); // suppress EPIPE when stream ends

  // Pipe the buffered/live mulaw stream into ffmpeg stdin.
  // { end: false } keeps ffmpeg alive when the PassThrough is replaced on the
  // next call; the STOP handler kills ffmpeg explicitly.
  if (currentMulawStream) {
    currentMulawStream.pipe(ffIn.stdin, { end: false });
  } else {
    console.warn('[HomeKit] No mulaw stream available — no audio will be sent');
  }

  // -------------------------------------------------------------------------
  // Outbound ffmpeg
  //
  // iPhone → SRTP → returnAudioPort → ffmpeg (Opus decode + mulaw encode)
  //        → stdout → Node.js → Twilio WebSocket JSON envelope
  //
  // The SDP file tells ffmpeg how to receive and decrypt the SRTP stream.
  //
  // Payload type 110 is what hap-nodejs assigns to Opus in its RTSP/HAP
  // negotiation. Verify with:
  //   tcpdump -i lo -n 'udp port <returnAudioPort>' -X | head -40
  // The RTP payload type is in byte 1 of the RTP header (& 0x7F).
  // If it differs, update the m= and a=rtpmap: lines accordingly.
  // -------------------------------------------------------------------------
  const returnParams = srtpParams(s.returnAudioKey, s.returnAudioSalt);
  const sdpPath = `/tmp/intercom_return_${sessionID}.sdp`;

  fs.writeFileSync(sdpPath, [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=Return Audio',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=audio ${s.returnAudioPort} RTP/SAVP 110`,
    'a=rtpmap:110 opus/48000/2',
    'a=fmtp:110 minptime=10;useinbandfec=1',
    `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${returnParams}`,
    'a=recvonly',
    '',
  ].join('\r\n'));

  const ffOut = spawn('ffmpeg', [
    '-y', '-loglevel', 'warning',
    '-protocol_whitelist', 'file,crypto,udp,rtp',
    '-f', 'sdp', '-i', sdpPath,
    // Decode Opus → resample → encode mulaw/8kHz
    '-ar', '8000', '-ac', '1',
    '-c:a', 'pcm_mulaw',
    '-f', 'mulaw',
    '-fflags', '+nobuffer',
    '-flush_packets', '1',
    'pipe:1',
  ]);

  ffOut.stderr.on('data', d => process.stderr.write('[ffOut] ' + d));
  ffOut.on('close', code => console.log('[ffOut] exited', code));

  // Forward each decoded mulaw chunk to Twilio as a media event.
  ffOut.stdout.on('data', chunk => {
    if (!state.activeCall) return;
    state.activeCall.wsConnection.sendUTF(JSON.stringify({
      event:     'media',
      streamSid: state.activeCall.streamSid,
      media:     { payload: chunk.toString('base64') },
    }));
  });

  activeSessions.set(sessionID, { ...s, ffIn, ffOut, sdpPath });
  callback();
}

// ---------------------------------------------------------------------------
// Session stop: tear down ffmpeg, optionally hang up Twilio call
// ---------------------------------------------------------------------------

function _stopSession(sessionID, hangUp) {
  const s = activeSessions.get(sessionID);
  if (!s) return;

  if (s.ffIn) {
    if (currentMulawStream) {
      try { currentMulawStream.unpipe(s.ffIn.stdin); } catch {}
    }
    s.ffIn.kill('SIGINT');
  }
  if (s.ffOut) s.ffOut.kill('SIGINT');
  if (s.sdpPath) { try { fs.unlinkSync(s.sdpPath); } catch {} }

  activeSessions.delete(sessionID);

  if (hangUp && state.activeCall) {
    hangUpCall(state.activeCall.callSid).catch(e =>
      console.error('[Twilio] hangup failed:', e.message)
    );
  }
}

// ---------------------------------------------------------------------------
// Accessory construction
// ---------------------------------------------------------------------------

const accessory = new Accessory(
  'Apartment Intercom',
  hapUuid.generate('homekit-intercom-v1')
);

accessory
  .getService(Service.AccessoryInformation)
  .setCharacteristic(Characteristic.Manufacturer, 'DIY')
  .setCharacteristic(Characteristic.Model,        'RPi Intercom')
  .setCharacteristic(Characteristic.SerialNumber, 'RPI-001');

// ---- Doorbell ----
const doorbellService = accessory.addService(Service.Doorbell, 'Intercom Doorbell');

// ---- Lock (triggers DTMF unlock) ----
const lockService = accessory.addService(Service.LockMechanism, 'Intercom Lock');
lockService
  .getCharacteristic(Characteristic.LockCurrentState)
  .setValue(Characteristic.LockCurrentState.SECURED);

lockService
  .getCharacteristic(Characteristic.LockTargetState)
  .onSet(async value => {
    if (value === Characteristic.LockTargetState.UNSECURED && state.activeCall) {
      try {
        await unlockDoor(state.activeCall.callSid);
      } catch (e) {
        console.error('[Twilio] unlock failed:', e.message);
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
      console.warn('[HomeKit] Unlock requested but no active call');
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
        [640,  360, 15],
        [320,  240, 15],
      ],
      codec: {
        profiles: [H264Profile.BASELINE],
        levels:   [H264Level.LEVEL3_1],
      },
    },
    audio: {
      twoWayAudio: true,
      codecs: [
        {
          type:       AudioStreamingCodecType.OPUS,
          samplerate: AudioStreamingSamplerate.KHZ_16,
        },
      ],
    },
  },
});

accessory.configureController(cameraController);

accessory.publish({
  username:   process.env.HAP_USERNAME || 'AA:BB:CC:DD:EE:FF',
  pincode:    process.env.HAP_PINCODE  || 'XXX-XX-XXX',
  port:       parseInt(process.env.HAP_PORT, 10) || 47129,
  category:   Categories.VIDEO_DOORBELL,
  advertiser: hap.MDNSAdvertiser.AVAHI,
});

const hapPincode = process.env.HAP_PINCODE || 'XXX-XX-XXX';
console.log(`[HomeKit] Accessory published — pair with pincode ${hapPincode}`);
console.log(`[HomeKit] Or scan this QR code with the Home app:\n`);
qrcode.generate(accessory.setupURI(), { small: true });

// Kick off snapshot generation asynchronously (non-blocking)
initSnapshot().then(() => console.log('[HomeKit] Snapshot ready'));

// ---------------------------------------------------------------------------
// Exports called by server.js
// ---------------------------------------------------------------------------

/**
 * Ring the HomeKit doorbell.
 * Called when the Twilio WebSocket fires the 'start' event.
 */
function triggerDoorbell() {
  doorbellService
    .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
    .updateValue(0); // 0 = SINGLE_PRESS
  console.log('[HomeKit] Doorbell triggered');
}

/**
 * Set (or replace) the PassThrough stream that delivers mulaw bytes.
 * Called at the start of each new Twilio call.
 */
function setMulawPassthrough(stream) {
  currentMulawStream = stream;
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

module.exports = { triggerDoorbell, setMulawPassthrough, endHapSession };
