'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MediaStream } = require('../src/core/media-stream');

const GOOD_TOKEN = 'good-token';
const VALID_CALL_SID = `CA${'0123456789abcdef'.repeat(2)}`;
const OTHER_CALL_SID = `CA${'fedcba9876543210'.repeat(2)}`;
const MULAW_FRAME_B64 = Buffer.alloc(160, 0xff).toString('base64');

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this;
  },
};

class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closeCalls = 0;
  }

  sendUTF(message) {
    this.sent.push(JSON.parse(message));
  }

  close() {
    this.closeCalls++;
    this.emit('close');
  }
}

function createFakeState() {
  return {
    activeCall: null,
    rejectStart: false,
    lastActivity: null,
    startCall({ callSid, streamSid, wsConnection }) {
      if (this.rejectStart) return { ok: false, reason: 'another call is already active' };
      this.activeCall = { callSid, streamSid, wsConnection };
      return { ok: true, session: this.activeCall };
    },
    getActiveCall() {
      return this.activeCall;
    },
    markActivity(callSid, eventName) {
      this.lastActivity = { callSid, eventName };
      return true;
    },
    clearIfConnection(wsConnection) {
      if (this.activeCall && this.activeCall.wsConnection === wsConnection) {
        const session = this.activeCall;
        this.activeCall = null;
        return { cleared: true, session };
      }
      return { cleared: false, session: null };
    },
  };
}

function createFakeHomekit({ reboundSessions = 0 } = {}) {
  return {
    doorbellCount: 0,
    endHapSessionCount: 0,
    clearedStreams: [],
    boundStream: null,
    setMulawPassthrough(stream) {
      this.boundStream = stream;
      return reboundSessions;
    },
    triggerDoorbell() {
      this.doorbellCount++;
    },
    clearMulawPassthrough(stream) {
      this.clearedStreams.push(stream);
    },
    endHapSession() {
      this.endHapSessionCount++;
    },
  };
}

function createHarness({ reboundSessions = 0 } = {}) {
  const connection = new FakeConnection();
  const state = createFakeState();
  const homekit = createFakeHomekit({ reboundSessions });
  const registry = new Map();
  const stream = new MediaStream(connection, {
    logger: noopLogger,
    state,
    homekit,
    registry,
    verifyStreamToken: (token) =>
      token === GOOD_TOKEN
        ? { ok: true, callSid: VALID_CALL_SID }
        : { ok: false, reason: 'invalid token signature' },
    tokenParameterName: 'token',
    startTimeoutMs: 60000,
    maxUtf8Bytes: 4096,
    mediaPayloadMaxBytes: 512,
  });
  return { connection, state, homekit, registry, stream };
}

function send(connection, payload) {
  connection.emit('message', { type: 'utf8', utf8Data: JSON.stringify(payload) });
}

function sendStart(connection, { callSid = VALID_CALL_SID, token = GOOD_TOKEN } = {}) {
  send(connection, {
    event: 'start',
    start: { callSid, streamSid: 'MZ123', customParameters: { token } },
  });
}

describe('media stream protocol', () => {
  test('valid start registers the call and rings the doorbell', () => {
    const h = createHarness();
    sendStart(h.connection);

    assert.equal(h.stream.started, true);
    assert.equal(h.state.activeCall.callSid, VALID_CALL_SID);
    assert.equal(h.registry.get(VALID_CALL_SID), h.stream);
    assert.equal(h.homekit.doorbellCount, 1);
    assert.equal(h.homekit.boundStream, h.stream.mulawStream);
    assert.ok(h.stream.ringbackTimer, 'ringback should be running');
    h.connection.close();
  });

  test('start with live HomeKit sessions skips doorbell and ringback', () => {
    const h = createHarness({ reboundSessions: 1 });
    sendStart(h.connection);

    assert.equal(h.stream.hasHomekitSession, true);
    assert.equal(h.homekit.doorbellCount, 0);
    assert.equal(h.stream.ringbackTimer, null);
    h.connection.close();
  });

  test('start with a bad token closes without registering the call', () => {
    const h = createHarness();
    sendStart(h.connection, { token: 'forged' });

    assert.equal(h.stream.started, false);
    assert.equal(h.state.activeCall, null);
    assert.ok(h.connection.closeCalls >= 1);
  });

  test('start with a token bound to another call is rejected', () => {
    const h = createHarness();
    sendStart(h.connection, { callSid: OTHER_CALL_SID });

    assert.equal(h.stream.started, false);
    assert.equal(h.state.activeCall, null);
    assert.ok(h.connection.closeCalls >= 1);
  });

  test('start is rejected when another call is active', () => {
    const h = createHarness();
    h.state.rejectStart = true;
    sendStart(h.connection);

    assert.equal(h.stream.started, false);
    assert.ok(h.connection.closeCalls >= 1);
  });

  test('duplicate start closes the connection', () => {
    const h = createHarness();
    sendStart(h.connection);
    sendStart(h.connection);

    assert.ok(h.connection.closeCalls >= 1);
  });

  test('media before start closes the connection', () => {
    const h = createHarness();
    send(h.connection, { event: 'media', media: { payload: MULAW_FRAME_B64 } });

    assert.ok(h.connection.closeCalls >= 1);
  });

  test('media is forwarded only once a HomeKit session is live', () => {
    const h = createHarness();
    sendStart(h.connection);

    send(h.connection, { event: 'media', media: { payload: MULAW_FRAME_B64 } });
    assert.equal(h.stream.mulawStream.readableLength, 0, 'no forwarding before live view');
    assert.deepEqual(h.state.lastActivity, { callSid: VALID_CALL_SID, eventName: 'twilio-media' });

    h.stream.markHomekitSessionStarted();
    send(h.connection, { event: 'media', media: { payload: MULAW_FRAME_B64 } });
    assert.equal(h.stream.mulawStream.readableLength, 160);
    assert.equal(h.stream.ringbackTimer, null, 'ringback stops when the live view starts');
    h.connection.close();
  });

  test('oversized media payload closes the connection', () => {
    const h = createHarness();
    sendStart(h.connection);
    send(h.connection, {
      event: 'media',
      media: { payload: Buffer.alloc(1024).toString('base64') },
    });

    assert.ok(h.connection.closeCalls >= 1);
  });

  test('invalid JSON and oversized messages close the connection', () => {
    const h1 = createHarness();
    h1.connection.emit('message', { type: 'utf8', utf8Data: 'not json' });
    assert.ok(h1.connection.closeCalls >= 1);

    const h2 = createHarness();
    h2.connection.emit('message', { type: 'utf8', utf8Data: 'x'.repeat(5000) });
    assert.ok(h2.connection.closeCalls >= 1);
  });

  test('stop tears the session down exactly once', () => {
    const h = createHarness();
    sendStart(h.connection);
    send(h.connection, { event: 'stop' });

    assert.equal(h.stream.closed, true);
    assert.equal(h.registry.size, 0);
    assert.equal(h.state.activeCall, null);
    assert.equal(h.homekit.endHapSessionCount, 1);
    assert.deepEqual(h.homekit.clearedStreams, [h.stream.mulawStream]);
    assert.equal(h.stream.mulawStream.destroyed, true);

    // A later WS close must not re-run teardown.
    h.connection.close();
    assert.equal(h.homekit.endHapSessionCount, 1);
  });

  test('connection close without stop also cleans up', () => {
    const h = createHarness();
    sendStart(h.connection);
    h.connection.close();

    assert.equal(h.stream.closed, true);
    assert.equal(h.state.activeCall, null);
    assert.equal(h.homekit.endHapSessionCount, 1);
  });
});
