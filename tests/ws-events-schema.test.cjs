'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseTwilioWsEvent, parseTwilioMediaPayload } = require('../src/core/ws-events-schema');
const { withEnv, freshRequire } = require('./helpers/env.cjs');

const VALID_ENV = {
  TWILIO_ACCOUNT_SID: 'AC12345678901234567890123456789012',
  TWILIO_AUTH_TOKEN: 'test_auth_token',
  TWILIO_PHONE_NUMBER: '+15551234567',
  PORT: '8080',
  TUNNEL_HOSTNAME: 'intercom.example.com',
  STREAM_AUTH_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  STATUS_API_TOKEN: '1234567890abcdef',
  HAP_USERNAME: 'AA:BB:CC:DD:EE:11',
  HAP_PINCODE: '123-45-678',
  HAP_PORT: '47129',
};

describe('ws event schema parsing', () => {
  test('parses valid connected/start/media/stop events', () => {
    const connected = parseTwilioWsEvent({ event: 'connected' });
    assert.equal(connected.ok, true);
    assert.equal(connected.data.event, 'connected');

    const start = parseTwilioWsEvent({
      event: 'start',
      start: {
        callSid: 'CA123',
        streamSid: 'MZ123',
        customParameters: { token: 'stream-token' },
      },
    });
    assert.equal(start.ok, true);
    assert.equal(start.data.start.callSid, 'CA123');
    assert.equal(start.data.start.streamSid, 'MZ123');
    assert.equal(start.data.start.customParameters.token, 'stream-token');

    const media = parseTwilioWsEvent({
      event: 'media',
      media: { payload: 'aGVsbG8=' },
    });
    assert.equal(media.ok, true);
    assert.equal(media.data.media.payload, 'aGVsbG8=');

    const stop = parseTwilioWsEvent({ event: 'stop' });
    assert.equal(stop.ok, true);
    assert.equal(stop.data.event, 'stop');

    const dtmf = parseTwilioWsEvent({ event: 'dtmf', dtmf: { digit: '9' } });
    assert.equal(dtmf.ok, true);
    assert.equal(dtmf.event, 'dtmf');
    assert.equal(dtmf.data.dtmf.digit, '9');
  });

  test('treats unknown events as ignored', () => {
    const result = parseTwilioWsEvent({ event: 'mark', mark: { name: 'foo' } });
    assert.equal(result.ok, true);
    assert.equal(result.unsupported, true);
    assert.equal(result.event, 'mark');
  });

  test('accepts bidirectional stream start payload without custom parameters', () => {
    const result = parseTwilioWsEvent({
      event: 'start',
      start: {
        callSid: 'CA123',
        streamSid: 'MZ123',
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.start.callSid, 'CA123');
    assert.equal(result.data.start.customParameters, undefined);
  });

  test('rejects malformed start event shape', () => {
    const result = parseTwilioWsEvent({
      event: 'start',
      start: { callSid: 'CA123' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid start payload');
  });

  test('rejects malformed media event shape', () => {
    const result = parseTwilioWsEvent({ event: 'media' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid media payload');
  });

  test('rejects null and missing event payloads', () => {
    const nullResult = parseTwilioWsEvent(null);
    assert.equal(nullResult.ok, false);
    assert.equal(nullResult.reason, 'missing event field');

    const emptyResult = parseTwilioWsEvent({});
    assert.equal(emptyResult.ok, false);
    assert.equal(emptyResult.reason, 'missing event field');
  });
});

describe('media payload parsing', () => {
  test('parses valid base64 payload', () => {
    const payload = Buffer.from('hello').toString('base64');
    const result = parseTwilioMediaPayload(payload, 512);
    assert.equal(result.ok, true);
    assert.equal(result.decoded.toString('utf8'), 'hello');
  });

  test('rejects invalid base64 payload', () => {
    const result = parseTwilioMediaPayload('!!!!', 512);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid media payload encoding');
  });

  test('rejects oversized decoded payload', () => {
    const oversized = Buffer.alloc(513, 0x41).toString('base64');
    const result = parseTwilioMediaPayload(oversized, 512);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'media payload too large');
  });
});

describe('stream auth TwiML helpers', () => {
  test('builds connect stream TwiML with a consumable token', () => {
    withEnv(VALID_ENV, () => {
      const { buildConnectStreamTwiml, verifyAndConsumeStreamToken } = freshRequire(
        '../../src/core/stream-auth'
      );
      const twiml = buildConnectStreamTwiml('CA123');
      const token = twiml.match(/name="token" value="([^"]+)"/)[1];

      assert.match(twiml, /<Connect><Stream url="wss:\/\/intercom\.example\.com\/media">/);
      assert.equal(verifyAndConsumeStreamToken(token).ok, true);
    });
  });
});
