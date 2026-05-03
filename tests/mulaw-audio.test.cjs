'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  createDtmfMulawTone,
  createRingbackMulawCycle,
  linear16ToMulaw,
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
