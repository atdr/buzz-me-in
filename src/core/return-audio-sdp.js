'use strict';

/**
 * Return-audio SDP file handling for the outbound (HomeKit → Twilio) ffmpeg
 * pipeline. The SDP embeds the SRTP master key/salt, so files are written
 * into a process-private 0700 temp directory with mode 0600 instead of
 * world-readable predictable paths directly under /tmp.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let sdpDir = null;

/** Lazily create the private per-process SDP directory (mkdtemp → 0700). */
function ensureSdpDir() {
  if (!sdpDir) {
    sdpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercom-'));
  }
  return sdpDir;
}

/**
 * @param {{ port: number, payloadType: number, srtpParams: string }} input
 * @returns {string}
 */
function buildReturnAudioSdp({ port, payloadType, srtpParams }) {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=Return Audio',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=audio ${port} RTP/SAVP ${payloadType}`,
    `a=rtpmap:${payloadType} opus/48000/2`,
    `a=fmtp:${payloadType} minptime=10;useinbandfec=1`,
    `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${srtpParams}`,
    'a=recvonly',
    '',
  ].join('\r\n');
}

/**
 * Write the SDP for a HAP session into the private directory.
 *
 * The 0700 directory (owned by this process) is what prevents another local
 * user from reading the SRTP key or planting a symlink at the target path, so
 * an overwrite (`w`) is safe: a re-issued START for the same session simply
 * refreshes the file rather than throwing, keeping _startSession idempotent.
 *
 * @param {{ sessionID: string, port: number, payloadType: number, srtpParams: string }} input
 * @returns {string} absolute path of the written SDP file
 */
function writeReturnAudioSdp({ sessionID, port, payloadType, srtpParams }) {
  const safeName = String(sessionID).replace(/[^A-Za-z0-9_-]/g, '_');
  const sdpPath = path.join(ensureSdpDir(), `return_${safeName}.sdp`);
  fs.writeFileSync(sdpPath, buildReturnAudioSdp({ port, payloadType, srtpParams }), {
    mode: 0o600,
    flag: 'w',
  });
  return sdpPath;
}

/**
 * Best-effort removal of a previously written SDP file.
 * @param {string} sdpPath
 */
function removeReturnAudioSdp(sdpPath) {
  try {
    fs.unlinkSync(sdpPath);
  } catch {}
}

module.exports = {
  buildReturnAudioSdp,
  ensureSdpDir,
  removeReturnAudioSdp,
  writeReturnAudioSdp,
};
