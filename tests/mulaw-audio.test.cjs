'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  createRingbackMulawCycle,
  linear16ToMulaw,
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
});
