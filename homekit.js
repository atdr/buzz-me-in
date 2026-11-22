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
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');

const config = require('./src/core/config');
const state = require('./src/core/state');
const { sendDtmfSequence, sendMulawAudio } = require('./src/core/mulaw-audio');
const { buildInboundFfmpegArgs } = require('./src/core/inbound-ffmpeg-args');
const {
  removeReturnAudioSdp,
  removeSdpDir,
  writeReturnAudioSdp,
} = require('./src/core/return-audio-sdp');
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

/** @returns {Promise<void>} */
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
let onHapSessionEnded = null;

function getActiveCall() {
  return state.getActiveCall();
}

function attachMulawStreamToSession(sessionID, stream) {
  const session = activeSessions.get(sessionID);
  if (
    !session ||
    !stream ||
    stream.destroyed ||
    !session.ffIn ||
    !session.ffIn.stdin ||
    session.ffIn.stdin.destroyed
  ) {
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

/**
 * Spawn both ffmpeg legs for a START and answer HomeKit's callback once.
 *
 * Node reports a failed spawn (ENOENT with ffmpeg missing from PATH, EAGAIN or
 * ENOMEM under pressure) as an asynchronous 'error' event on the child, not as
 * a throw. An 'error' event with no listener is rethrown, reaches the
 * uncaughtException handler in server.js and exits the process, which drops
 * the Twilio call with it. So both children carry an 'error' listener, and the
 * callback waits for each child's 'spawn' event (one tick away) before telling
 * HomeKit the stream is up: a START either succeeds with two running
 * processes, or fails once with an error and leaves nothing behind.
 *
 * @param {string} sessionID
 * @param {any} s Session record from prepareStreamSession.
 * @param {any} request HAP START request.
 * @param {(error?: Error) => void} callback HAP's START callback.
 */
function _startSession(sessionID, s, request, callback) {
  // Reopening the live view inside the grace window means the user is not
  // finished after all.
  cancelPendingHangUp('homekit-session-restarted');
  const audio = request.audio;

  let settled = false;
  /** @type {import('child_process').ChildProcess | undefined} */
  let ffIn;
  /** @type {import('child_process').ChildProcess | undefined} */
  let ffOut;
  let sdpPath;
  /** @type {Set<import('child_process').ChildProcess>} */
  const awaitingSpawn = new Set();

  /**
   * Fail this START exactly once: tear down whatever did start, forget the
   * session and hand HomeKit the error. HAP-NodeJS resets its own stream
   * state when the START callback carries an error.
   * @param {string} reason
   * @param {unknown} error
   */
  function failStart(reason, error) {
    settled = true;
    logger.error('Failed to start HomeKit stream session', {
      event: 'stream-start-failed',
      reason,
      sessionId: sessionID,
      error,
    });
    const current = activeSessions.get(sessionID);
    // A STOP can only have removed or replaced the entry in between if HAP
    // misbehaved; only forget the record this START owns.
    if (current && (current.ffIn === undefined || current.ffIn === ffIn)) {
      activeSessions.delete(sessionID);
    }
    releaseSessionResources({ ffIn, ffOut, sdpPath, mulawStream: current && current.mulawStream });
    callback(error instanceof Error ? error : new Error(String(error)));
  }

  /**
   * @param {'ffin' | 'ffout'} leg
   * @param {import('child_process').ChildProcess} child
   */
  function watchSpawn(leg, child) {
    awaitingSpawn.add(child);
    child.once('spawn', () => {
      awaitingSpawn.delete(child);
      if (settled || awaitingSpawn.size !== 0) return;
      settled = true;
      const activeCall = getActiveCall();
      if (activeCall && onHapSessionStarted) {
        onHapSessionStarted(activeCall.callSid);
      }
      callback();
    });
    child.on('error', (error) => {
      if (!settled) {
        failStart(`${leg}-spawn-failed`, error);
        return;
      }
      // The START has already been answered, so this is a running session
      // losing a process rather than a failed start.
      if (!ownsLiveSession(child)) return;
      _endSessionUnexpectedly(sessionID, `${leg}-process-error`, { error });
    });
  }

  /**
   * Whether `child` still belongs to this session's live entry. _stopSession
   * and failStart remove the entry before killing anything, so a child they
   * stopped on purpose is never mistaken for one that died on its own.
   * @param {import('child_process').ChildProcess} child
   */
  function ownsLiveSession(child) {
    if (!settled) return false;
    const current = activeSessions.get(sessionID);
    return Boolean(current) && (current.ffIn === child || current.ffOut === child);
  }

  // Any synchronous throw from here on (spawn() rejecting its arguments, a
  // child with no stdio after EMFILE, the SDP write) must also tear down what
  // already started and fail the START, otherwise an ffmpeg leaks and
  // HomeKit's callback never fires. Asynchronous spawn failures arrive on the
  // 'error' listeners in watchSpawn instead.
  try {
    // Inbound ffmpeg: see src/core/inbound-ffmpeg-args.js for the pipeline.
    ffIn = spawn(
      'ffmpeg',
      buildInboundFfmpegArgs({
        video: request.video,
        audio,
        videoParams: srtpParams(s.hkVideoKey, s.hkVideoSalt),
        audioParams: srtpParams(s.hkAudioKey, s.hkAudioSalt),
        targetAddress: s.targetAddress,
        hkVideoPort: s.hkVideoPort,
        hkAudioPort: s.hkAudioPort,
        videoSsrc: s.videoSsrc,
        audioSsrc: s.audioSsrc,
      })
    );
    watchSpawn('ffin', ffIn);

    ffIn.stderr.on('data', (d) => {
      logger.warn('Inbound ffmpeg stderr', {
        event: 'ffin-stderr',
        reason: 'ffmpeg-stderr',
        detail: d.toString('utf8').trim(),
        sessionId: sessionID,
      });
    });
    const inbound = ffIn;
    ffIn.on('close', (code, signal) => {
      logger.info('Inbound ffmpeg exited', {
        event: 'ffin-exit',
        reason: code === 0 ? 'clean-exit' : 'nonzero-exit',
        exitCode: code,
        sessionId: sessionID,
      });
      if (ownsLiveSession(inbound)) {
        _endSessionUnexpectedly(sessionID, 'ffin-exited', { exitCode: code, signal });
      }
    });
    ffIn.stdin.on('error', () => {}); // suppress EPIPE when stream ends

    // -----------------------------------------------------------------------
    // Outbound ffmpeg
    //
    // iPhone → SRTP → returnAudioPort → ffmpeg (Opus decode + mulaw encode)
    //        → stdout → Node.js → Twilio WebSocket JSON envelope
    //
    // The SDP file tells ffmpeg how to receive and decrypt the SRTP stream.
    //
    // Use the negotiated Opus payload type from HomeKit's START request; older
    // versions assumed 110, which breaks when the controller chooses otherwise.
    // -----------------------------------------------------------------------
    sdpPath = writeReturnAudioSdp({
      sessionID,
      port: s.returnAudioPort,
      payloadType: audio.pt,
      srtpParams: srtpParams(s.returnAudioKey, s.returnAudioSalt),
    });

    ffOut = spawn('ffmpeg', [
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
    watchSpawn('ffout', ffOut);

    ffOut.stderr.on('data', (d) => {
      logger.warn('Outbound ffmpeg stderr', {
        event: 'ffout-stderr',
        reason: 'ffmpeg-stderr',
        detail: d.toString('utf8').trim(),
        sessionId: sessionID,
      });
    });
    const outbound = ffOut;
    ffOut.on('close', (code, signal) => {
      logger.info('Outbound ffmpeg exited', {
        event: 'ffout-exit',
        reason: code === 0 ? 'clean-exit' : 'nonzero-exit',
        exitCode: code,
        sessionId: sessionID,
      });
      if (ownsLiveSession(outbound)) {
        _endSessionUnexpectedly(sessionID, 'ffout-exited', { exitCode: code, signal });
      }
    });

    // Forward each decoded mulaw chunk to Twilio as a media event.
    ffOut.stdout.on('data', (chunk) => {
      const activeCall = getActiveCall();
      if (!activeCall || !activeCall.wsConnection || !activeCall.streamSid) return;
      sendMulawAudio(activeCall, chunk);
      state.markActivity(activeCall.callSid, 'homekit-outbound-media');
    });

    activeSessions.set(sessionID, { ...s, ffIn, ffOut, sdpPath });
    attachMulawStreamToSession(sessionID, currentMulawStream);
  } catch (error) {
    // An 'error' event can only be pending, never already delivered, so the
    // START is still unanswered here.
    failStart('session-setup-threw', error);
  }
}

// ---------------------------------------------------------------------------
// Session stop: tear down ffmpeg, optionally hang up Twilio call
// ---------------------------------------------------------------------------

const FFMPEG_KILL_GRACE_MS = 2000;

/**
 * SIGINT first for a clean ffmpeg exit, escalating to SIGKILL if the
 * process is still alive after the grace period (a wedged ffmpeg would
 * otherwise hold its UDP ports and CPU indefinitely).
 * @param {import('child_process').ChildProcess} proc
 */
function killFfmpeg(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGINT');
  const escalation = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }, FFMPEG_KILL_GRACE_MS);
  escalation.unref();
  proc.once('exit', () => clearTimeout(escalation));
}

/**
 * Unpipe the mulaw stream from ffIn, stop both ffmpeg legs and remove the
 * return-audio SDP. Every field may be missing: a START that failed partway
 * through has only what it got to.
 * @param {{ ffIn?: import('child_process').ChildProcess, ffOut?: import('child_process').ChildProcess, sdpPath?: string, mulawStream?: import('stream').Readable }} resources
 */
function releaseSessionResources({ ffIn, ffOut, sdpPath, mulawStream }) {
  if (ffIn) {
    const source = mulawStream || currentMulawStream;
    if (source && ffIn.stdin) {
      try {
        source.unpipe(ffIn.stdin);
      } catch {}
    }
    killFfmpeg(ffIn);
  }
  if (ffOut) killFfmpeg(ffOut);
  if (sdpPath) removeReturnAudioSdp(sdpPath);
}

function _stopSession(sessionID, hangUp) {
  const s = activeSessions.get(sessionID);
  if (!s) return;
  activeSessions.delete(sessionID);

  releaseSessionResources(s);

  // Only the last session ending means the user is finished. HomeKit runs up
  // to cameraStreamCount sessions at once, and moving between the room view's
  // camera tile and the full camera view starts a second one, so a STOP here
  // routinely arrives while another session is still streaming. Hanging up on
  // it kills a live call: seen on 2026-09-12, where session ac5c8c21 stopping
  // ended the call under session d332e46a three seconds into the stream.
  const activeCall = getActiveCall();
  if (activeSessions.size !== 0) return;

  // ffIn is dead and unpiped by now, so tell the media stream to stop writing
  // into a PassThrough with no consumer. See markHomekitSessionEnded.
  if (activeCall && onHapSessionEnded) onHapSessionEnded(activeCall.callSid);

  if (hangUp && activeCall) {
    scheduleHangUp(activeCall.callSid, sessionID);
  }
}

/**
 * End a session the server decided to end, and tell HAP-NodeJS so the Home
 * app closes the live view and the stream slot is freed. A STOP from HomeKit
 * needs none of this, because HAP has already reset its own state by then.
 *
 * forceStopStreamingSession() only resets HAP's state for that stream
 * (RTPStreamManagement.forceStop → handleSessionClosed in hap-nodejs 0.14.3);
 * it does not call back into handleStreamRequest, so this cannot recurse into
 * _stopSession. tests/homekit-hangup-grace.test.cjs pins that upstream.
 *
 * @param {string} sessionID
 */
function _stopSessionFromServer(sessionID) {
  _stopSession(sessionID, /* hangUp= */ false);
  cameraController.forceStopStreamingSession(sessionID);
}

/**
 * A running session lost one of its ffmpeg processes. Nothing restarts it, so
 * the session is over: stop the other leg, remove the SDP and close the HAP
 * stream rather than leave the resident a frozen, silent view.
 *
 * This deliberately does not schedule a hangup. Only a STOP from HomeKit means
 * the resident has finished; a crashed ffmpeg says nothing about that, and the
 * call is what the lock tile needs to send DTMF. The resident can reopen the
 * live view (a fresh START spawns new processes), and the caller hanging up
 * still ends the call.
 *
 * @param {string} sessionID
 * @param {string} reason
 * @param {Record<string, unknown>} fields
 */
function _endSessionUnexpectedly(sessionID, reason, fields) {
  logger.warn('HomeKit stream session ended unexpectedly', {
    event: 'stream-ended-unexpectedly',
    reason,
    sessionId: sessionID,
    ...fields,
  });
  _stopSessionFromServer(sessionID);
}

// ---------------------------------------------------------------------------
// Deferred hangup
//
// Closing the live view is not the same as being finished with the caller. The
// Home app reaches the lock tile two different ways: the grid button inside the
// camera view keeps the stream up, but backing out to the room view tears it
// down, and tapping the lock from there used to find no call left to send DTMF
// to. Holding the call open briefly after STOP makes both routes work, because
// unlock needs the call's WebSocket, not a HomeKit streaming session.
//
// The call is still hung up when the user really has finished; it just costs
// config.homekitHangupGraceMs of silence first, ffmpeg having already been
// killed above.
// ---------------------------------------------------------------------------

const HANGUP_GRACE_MS = config.homekitHangupGraceMs;

/** @type {{ timer: NodeJS.Timeout, callSid: string, sessionID: string } | null} */
let pendingHangUp = null;

function cancelPendingHangUp(reason) {
  if (!pendingHangUp) return;
  clearTimeout(pendingHangUp.timer);
  logger.info('Pending hangup cancelled', {
    event: 'hangup-cancelled',
    reason,
    callSid: pendingHangUp.callSid,
    sessionId: pendingHangUp.sessionID,
  });
  pendingHangUp = null;
}

/**
 * Restart the grace window, so a hangup cannot land on top of an action the
 * user has just taken. Without this an unlock tapped late in the window could
 * be cut off before the intercom acts on the digits.
 */
function deferPendingHangUp(reason) {
  if (!pendingHangUp) return;
  const { callSid, sessionID } = pendingHangUp;
  clearTimeout(pendingHangUp.timer);
  pendingHangUp = null;
  scheduleHangUp(callSid, sessionID, reason);
}

function scheduleHangUp(callSid, sessionID, reason = 'homekit-session-stopped') {
  cancelPendingHangUp('superseded');
  logger.info('Hangup scheduled after grace period', {
    event: 'hangup-scheduled',
    reason,
    callSid,
    sessionId: sessionID,
    graceMs: HANGUP_GRACE_MS,
  });
  const timer = setTimeout(() => {
    pendingHangUp = null;
    const activeCall = getActiveCall();
    // The caller may have hung up during the window, and the slot may already
    // hold a different call. Either way this one is no longer ours to end.
    if (!activeCall || activeCall.callSid !== callSid) {
      logger.info('Pending hangup skipped; call already gone', {
        event: 'hangup-skipped',
        reason: 'call-no-longer-active',
        callSid,
        sessionId: sessionID,
      });
      return;
    }
    hangUpCall(callSid)
      .then((result) => {
        if (result && result.alreadyEnded) {
          logger.info('Twilio call already ended while stopping HomeKit session', {
            event: 'hangup-call-already-ended',
            reason: 'twilio-call-not-in-progress',
            callSid,
            sessionId: sessionID,
          });
        }
      })
      .catch((error) => {
        logger.error('Failed to hang up call while stopping HomeKit session', {
          event: 'hangup-call-failed',
          reason: 'twilio-hangup-failed',
          callSid,
          sessionId: sessionID,
          error,
        });
      });
  }, HANGUP_GRACE_MS);
  timer.unref();
  pendingHangUp = { timer, callSid, sessionID };
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
        // Unlocking from the room view is the case this grace window exists
        // for, so give the intercom a full window to act on the digits rather
        // than whatever was left of the previous one.
        deferPendingHangUp('unlock-sent');
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

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

let started = false;

/**
 * Put the accessory on the network and prepare the snapshot.
 *
 * Everything above this is in-memory construction; every side effect that
 * reaches outside the process lives here. That split is deliberate: it lets
 * server.js, a test, or the coverage run require this module without binding
 * `HAP_PORT`, advertising a second accessory over Avahi alongside a live
 * service, or spawning ffmpeg. server.js calls this from main().
 *
 * @returns {void}
 */
function start() {
  if (started) {
    logger.warn('Accessory start requested twice; ignoring', {
      event: 'accessory-start-repeated',
      reason: 'already-started',
    });
    return;
  }
  started = true;

  accessory.publish({
    username: config.hapUsername,
    pincode: config.hapPincode,
    port: config.hapPort,
    category: Categories.VIDEO_DOORBELL,
    advertiser: hap.MDNSAdvertiser.AVAHI,
  });

  logger.info('Accessory published', {
    event: 'accessory-published',
  });
  // The setup QR encodes the pairing pincode, so only print it on an
  // interactive terminal — never into journald/log files.
  if (process.stdout.isTTY) {
    logger.info('Accessory QR setup URI generated', {
      event: 'accessory-qr-setup',
    });
    qrcode.generate(accessory.setupURI(), { small: true });
  } else {
    logger.info(
      'Pairing QR suppressed on non-interactive stdout; reprint it with buzz-me-in --qr',
      {
        event: 'accessory-qr-suppressed',
        reason: 'stdout-not-tty',
      }
    );
  }

  // Kick off snapshot generation asynchronously (non-blocking)
  initSnapshot().then(() =>
    logger.info('Snapshot initialized', {
      event: 'snapshot-ready',
    })
  );
}

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
 * Forget the current mulaw stream if it matches the one being torn down.
 * Without this, a HomeKit live view opened after the call ended would pipe
 * a destroyed stream into ffmpeg and crash on the unhandled 'error' event.
 */
function clearMulawPassthrough(stream) {
  if (currentMulawStream === stream) currentMulawStream = null;
}

/**
 * Force-close all active HAP sessions, including HAP's side of each stream so
 * the Home app closes the live view instead of freezing on its last frame.
 * Called when the call ends (Twilio 'stop', WebSocket close, stale reaper) and
 * on shutdown. Does NOT call hangUpCall — the call is already gone.
 */
function endHapSession() {
  // The caller is already gone, so a hangup left over from a closed live view
  // has nothing to end.
  cancelPendingHangUp('call-ended');
  for (const sessionID of [...activeSessions.keys()]) {
    _stopSessionFromServer(sessionID);
  }
}

function setOnHapSessionStarted(handler) {
  onHapSessionStarted = typeof handler === 'function' ? handler : null;
}

function setOnHapSessionEnded(handler) {
  onHapSessionEnded = typeof handler === 'function' ? handler : null;
}

/**
 * Graceful shutdown: tear down streaming sessions and unpublish the
 * accessory so the mDNS advertisement does not linger after exit.
 *
 * MUST be unpublish(), never destroy(). Both tear down the HAP server and the
 * mDNS advertiser, but destroy() additionally calls
 * Accessory.cleanupAccessoryData(), which deletes AccessoryInfo,
 * IdentifierCache and ControllerStorage from persist/ — i.e. it erases every
 * HomeKit pairing. destroy() means "this accessory is gone for good"; a
 * restart is not that. Using it here silently unpaired the accessory on every
 * clean stop, restart and reboot.
 */
function shutdown() {
  cancelPendingHangUp('shutdown');
  endHapSession();
  removeSdpDir();
  // Nothing to tear down if start() never ran: unpublish() on an accessory
  // that was never published has no HAP server or advertiser to stop.
  if (!started) return;
  accessory.unpublish().catch((error) => {
    logger.error('Failed to unpublish HAP accessory during shutdown', {
      event: 'accessory-unpublish-failed',
      reason: 'unpublish-threw',
      error,
    });
  });
}

module.exports = {
  start,
  triggerDoorbell,
  setMulawPassthrough,
  clearMulawPassthrough,
  endHapSession,
  setOnHapSessionStarted,
  setOnHapSessionEnded,
  shutdown,
  // Exported for tests/homekit-hangup-grace.test.cjs. Reaching the deferred
  // hangup through the streaming delegate would mean standing up a full SRTP
  // session, which tests nothing about the timer. _stopSession and the session
  // map go with them: driving only scheduleHangUp tests when the timer fires
  // but not whether it should have been set, which is where the live bug was.
  scheduleHangUp,
  cancelPendingHangUp,
  deferPendingHangUp,
  _stopSession,
  activeSessions,
  // Exported for the START tests in the same file, which drive a session
  // through handleStreamRequest with child_process.spawn stubbed.
  streamingDelegate,
};
