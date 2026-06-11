'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  createDtmfMulawTone,
  createRingbackMulawCycle,
  createRingbackWav,
  linear16ToMulaw,
  mulawToLinear16,
  sendDtmfSequence,
  sendMulawAudio,
} = require('../src/core/mulaw-audio');

describe('mu-law audio helpers', () => {
  test('encodes linear silence as mu-law silence', () => {
    assert.equal(linear16ToMulaw(0), 0xff);
  });

  test('creates a 3-second ringback cycle', () => {
    const payload = createRingbackMulawCycle();

    assert.equal(payload.length, 24000);
  });

  test('creates mu-law DTMF payload with trailing silence', () => {
    const payload = createDtmfMulawTone('9', { toneMs: 100, trailingSilenceMs: 20 });

    assert.equal(payload.length, 960);
    assert.notEqual(
      payload.subarray(0, 800).toString('hex'),
      Buffer.alloc(800, 0xff).toString('hex')
    );
    assert.equal(payload.subarray(800).toString('hex'), Buffer.alloc(160, 0xff).toString('hex'));
  });

  test('rejects unsupported DTMF digits', () => {
    assert.throws(() => createDtmfMulawTone('x'), /Unsupported DTMF digit/);
  });

  test('mu-law decode inverts encode within quantization error', () => {
    for (const sample of [0, 1000, -1000, 12000, -12000, 32000, -32000]) {
      const roundTripped = mulawToLinear16(linear16ToMulaw(sample));
      assert.ok(
        Math.abs(roundTripped - sample) <= Math.max(64, Math.abs(sample) / 16),
        `round trip of ${sample} gave ${roundTripped}`
      );
    }
  });

  test('creates a PCM16 WAV of one ringback cycle', () => {
    const wav = createRingbackWav();

    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.equal(wav.readUInt16LE(20), 1); // PCM format tag
    assert.equal(wav.readUInt16LE(22), 1); // mono
    assert.equal(wav.readUInt32LE(24), 8000); // sample rate
    assert.equal(wav.readUInt32LE(40), 24000 * 2); // 3 s of 16-bit samples
    assert.equal(wav.length, 44 + 24000 * 2);
  });

  test('sends audio to Twilio media stream', () => {
    const sent = [];
    const activeCall = {
      streamSid: 'MZ123',
      wsConnection: {
        sendUTF(message) {
          sent.push(JSON.parse(message));
        },
      },
    };

    sendMulawAudio(activeCall, Buffer.alloc(160, 0xff));

    assert.equal(sent.length, 1);
    assert.equal(sent[0].event, 'media');
    assert.equal(sent[0].streamSid, 'MZ123');
    assert.equal(Buffer.from(sent[0].media.payload, 'base64').length, 160);
  });

  test('sends DTMF sequence to Twilio media stream in 20ms chunks', async () => {
    const sent = [];
    const activeCall = {
      streamSid: 'MZ123',
      wsConnection: {
        sendUTF(message) {
          sent.push(JSON.parse(message));
        },
      },
    };

    await sendDtmfSequence(activeCall, 'w9', { toneMs: 40, trailingSilenceMs: 0, chunkMs: 20 });

    assert.equal(sent.length, 2);
    assert.equal(sent[0].event, 'media');
    assert.equal(sent[0].streamSid, 'MZ123');
    assert.equal(Buffer.from(sent[0].media.payload, 'base64').length, 160);
  });
});
