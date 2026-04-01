'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, freshRequire } = require('./helpers/env.cjs');

const BASE_ENV = {
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

function loadSchemaModule() {
  let loaded;
  withEnv(BASE_ENV, () => {
    loaded = freshRequire('../../ws-events-schema');
  });
  return loaded;
}

const { parseTwilioWsEvent, parseTwilioMediaPayload } = loadSchemaModule();

describe('ws event schema parsing', () => {
  test('parses valid connected/start/stop events', () => {
    const connected = parseTwilioWsEvent({ event: 'connected' });
    assert.equal(connected.ok, true);
    assert.equal(connected.data.event, 'connected');

    const start = parseTwilioWsEvent({
      event: 'start',
      start: { callSid: 'CA123', streamSid: 'MZ123' },
    });
    assert.equal(start.ok, true);
    assert.equal(start.data.start.callSid, 'CA123');
    assert.equal(start.data.start.streamSid, 'MZ123');

    const stop = parseTwilioWsEvent({ event: 'stop' });
    assert.equal(stop.ok, true);
    assert.equal(stop.data.event, 'stop');
  });

  test('treats unknown events as ignored', () => {
    const result = parseTwilioWsEvent({ event: 'mark', mark: { name: 'foo' } });
    assert.equal(result.ok, true);
    assert.equal(result.unsupported, true);
    assert.equal(result.event, 'mark');
  });

  test('rejects malformed start event shape', () => {
    const result = parseTwilioWsEvent({
      event: 'start',
      start: { callSid: 'CA123' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid start payload');
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
