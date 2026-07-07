const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  removeReturnAudioSdp,
  removeSdpDir,
  writeReturnAudioSdp,
} = require('../src/core/return-audio-sdp.js');

const SDP_INPUT = {
  port: 40000,
  payloadType: 110,
  srtpParams: 'c2VjcmV0LWtleS1hbmQtc2FsdA==',
};

test('return-audio SDP files', async (t) => {
  t.after(() => removeSdpDir());

  await t.test('written SDP body carries the port, payload type, and SRTP key', () => {
    const sdpPath = writeReturnAudioSdp({ sessionID: 'session-body', ...SDP_INPUT });
    const sdp = fs.readFileSync(sdpPath, 'utf8');
    assert.match(sdp, /m=audio 40000 RTP\/SAVP 110/);
    assert.match(sdp, /a=rtpmap:110 opus\/48000\/2/);
    assert.match(sdp, /a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:c2VjcmV0LWtleS1hbmQtc2FsdA==/);
    assert.match(sdp, /a=recvonly/);
    removeReturnAudioSdp(sdpPath);
  });

  await t.test('writes into a process-private directory, not bare tmp', () => {
    const sdpPath = writeReturnAudioSdp({ sessionID: 'session-private-dir', ...SDP_INPUT });
    const dir = path.dirname(sdpPath);
    assert.notEqual(dir, os.tmpdir());
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.match(path.basename(dir), /^intercom-/);
    removeReturnAudioSdp(sdpPath);
  });

  await t.test('file mode is 0600 and directory mode is 0700', () => {
    const sdpPath = writeReturnAudioSdp({ sessionID: 'session-modes', ...SDP_INPUT });
    assert.equal(fs.statSync(sdpPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(sdpPath)).mode & 0o777, 0o700);
    removeReturnAudioSdp(sdpPath);
  });

  await t.test('a re-issued write for the same session overwrites idempotently', () => {
    const input = { sessionID: 'session-idempotent', ...SDP_INPUT };
    const first = writeReturnAudioSdp(input);
    let second;
    assert.doesNotThrow(() => {
      second = writeReturnAudioSdp({ ...input, port: 40001 });
    });
    assert.equal(first, second);
    assert.match(fs.readFileSync(second, 'utf8'), /m=audio 40001 /);
    removeReturnAudioSdp(second);
  });

  await t.test('sanitizes hostile session IDs into the private directory', () => {
    const sdpPath = writeReturnAudioSdp({ sessionID: '../../etc/passwd', ...SDP_INPUT });
    assert.match(path.basename(path.dirname(sdpPath)), /^intercom-/);
    assert.match(path.basename(sdpPath), /^return_[A-Za-z0-9_-]+\.sdp$/);
    removeReturnAudioSdp(sdpPath);
  });

  await t.test('removeReturnAudioSdp deletes the file and tolerates missing paths', () => {
    const sdpPath = writeReturnAudioSdp({ sessionID: 'session-remove', ...SDP_INPUT });
    removeReturnAudioSdp(sdpPath);
    assert.equal(fs.existsSync(sdpPath), false);
    assert.doesNotThrow(() => removeReturnAudioSdp(sdpPath));
  });

  await t.test('removeSdpDir removes the whole private directory', () => {
    const sdpPath = writeReturnAudioSdp({ sessionID: 'session-dir-cleanup', ...SDP_INPUT });
    const dir = path.dirname(sdpPath);
    removeSdpDir();
    assert.equal(fs.existsSync(dir), false);
    // A later write recreates a fresh private directory.
    const next = writeReturnAudioSdp({ sessionID: 'session-after-cleanup', ...SDP_INPUT });
    assert.match(path.basename(path.dirname(next)), /^intercom-/);
    assert.notEqual(path.dirname(next), dir);
    removeReturnAudioSdp(next);
  });
});
