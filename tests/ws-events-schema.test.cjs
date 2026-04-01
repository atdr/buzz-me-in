'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseTwilioWsEvent, parseTwilioMediaPayload } = require('../ws-events-schema');

describe('ws event schema parsing', () => {
  test('parses valid connected/start/media/stop events', () => {
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

    const media = parseTwilioWsEvent({
      event: 'media',
      media: { payload: 'aGVsbG8=' },
    });
    assert.equal(media.ok, true);
    assert.equal(media.data.media.payload, 'aGVsbG8=');

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
