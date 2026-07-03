const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildReturnAudioSdp,
  ensureSdpDir,
  removeReturnAudioSdp,
  writeReturnAudioSdp,
} = require('../src/core/return-audio-sdp.js');

const SDP_INPUT = {
  port: 40000,
  payloadType: 110,
  srtpParams: 'c2VjcmV0LWtleS1hbmQtc2FsdA==',
};

test('return-audio SDP files', async (t) => {
  await t.test('SDP body carries the negotiated port, payload type, and SRTP key', () => {
    const sdp = buildReturnAudioSdp(SDP_INPUT);
    assert.match(sdp, /m=audio 40000 RTP\/SAVP 110/);
    assert.match(sdp, /a=rtpmap:110 opus\/48000\/2/);
    assert.match(sdp, /a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:c2VjcmV0LWtleS1hbmQtc2FsdA==/);
    assert.match(sdp, /a=recvonly/);
  });

  await t.test('writes into a process-private directory, not bare tmp', () => {
    const sdpPath = writeReturnAudioSdp({ sessionID: 'session-private-dir', ...SDP_INPUT });
    const dir = path.dirname(sdpPath);
    assert.notEqual(dir, os.tmpdir());
    assert.match(path.basename(dir), /^intercom-/);
    assert.equal(dir, ensureSdpDir());
    removeReturnAudioSdp(sdpPath);
  });

  await t.test('file mode is 0600 and directory mode is 0700', () => {
    const sdpPath = writeReturnAudioSdp({ sessionID: 'session-modes', ...SDP_INPUT });
    assert.equal(fs.statSync(sdpPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(sdpPath)).mode & 0o777, 0o700);
    removeReturnAudioSdp(sdpPath);
  });

  await t.test('refuses to overwrite an existing file (wx semantics)', () => {
    const input = { sessionID: 'session-duplicate', ...SDP_INPUT };
    const sdpPath = writeReturnAudioSdp(input);
    assert.throws(() => writeReturnAudioSdp(input), { code: 'EEXIST' });
    removeReturnAudioSdp(sdpPath);
  });

  await t.test('sanitizes hostile session IDs into the private directory', () => {
    const sdpPath = writeReturnAudioSdp({ sessionID: '../../etc/passwd', ...SDP_INPUT });
    assert.equal(path.dirname(sdpPath), ensureSdpDir());
    assert.match(path.basename(sdpPath), /^return_[A-Za-z0-9_-]+\.sdp$/);
    removeReturnAudioSdp(sdpPath);
  });

  await t.test('removeReturnAudioSdp deletes the file and tolerates missing paths', () => {
    const sdpPath = writeReturnAudioSdp({ sessionID: 'session-remove', ...SDP_INPUT });
    removeReturnAudioSdp(sdpPath);
    assert.equal(fs.existsSync(sdpPath), false);
    assert.doesNotThrow(() => removeReturnAudioSdp(sdpPath));
  });
});
