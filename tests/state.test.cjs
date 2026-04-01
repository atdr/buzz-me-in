'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { applyEnv, freshRequire } = require('./helpers/env.cjs');

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

let currentState = null;

function loadState(extraEnv) {
  const restore = applyEnv({ ...VALID_ENV, ...extraEnv });
  delete require.cache[require.resolve('../src/core/config')];
  currentState = freshRequire('../../src/core/state');
  return { state: currentState, restore };
}

describe('state session manager', () => {
  afterEach(() => {
    if (currentState) {
      currentState.stop();
      currentState = null;
    }
  });

  test('starts and reports an active call', () => {
    const { state, restore } = loadState();
    const ws = { id: 'conn1' };
    const started = state.startCall({
      callSid: 'CA111',
      streamSid: 'MZ111',
      wsConnection: ws,
    });

    assert.equal(started.ok, true);
    assert.deepEqual(state.getStatus(), { active: true, callSid: 'CA111' });
    assert.deepEqual(
      {
        callSid: state.getActiveCall().callSid,
        streamSid: state.getActiveCall().streamSid,
        wsConnection: state.getActiveCall().wsConnection,
        lastEvent: state.getActiveCall().lastEvent,
      },
      {
        callSid: 'CA111',
        streamSid: 'MZ111',
        wsConnection: ws,
        lastEvent: 'start',
      }
    );
    restore();
  });

  test('rejects concurrent distinct active calls', () => {
    const { state, restore } = loadState();
    const ws1 = {};
    const ws2 = {};
    const first = state.startCall({
      callSid: 'CA111',
      streamSid: 'MZ111',
      wsConnection: ws1,
    });
    const second = state.startCall({
      callSid: 'CA222',
      streamSid: 'MZ222',
      wsConnection: ws2,
    });

    assert.equal(first.ok, true);
    assert.deepEqual(second, {
      ok: false,
      reason: 'another call is already active',
    });
    assert.deepEqual(state.getStatus(), { active: true, callSid: 'CA111' });
    restore();
  });

  test('updates activity timestamp and event name', () => {
    const { state, restore } = loadState();
    const before = Date.now();
    state.startCall({
      callSid: 'CA111',
      streamSid: 'MZ111',
      wsConnection: {},
    });

    const updated = state.markActivity('CA111', 'twilio-media');
    const active = state.getActiveCall();

    assert.equal(updated, true);
    assert.equal(active.lastEvent, 'twilio-media');
    assert.equal(active.lastEventAtMs >= before, true);
    restore();
  });

  test('clears only when connection matches active call', () => {
    const { state, restore } = loadState();
    const ws = { id: 'conn1' };
    state.startCall({
      callSid: 'CA111',
      streamSid: 'MZ111',
      wsConnection: ws,
    });

    const mismatch = state.clearIfConnection({ id: 'conn2' }, 'ws-close');
    assert.equal(mismatch.cleared, false);
    assert.deepEqual(state.getStatus(), { active: true, callSid: 'CA111' });

    const cleared = state.clearIfConnection(ws, 'ws-close');
    assert.equal(cleared.cleared, true);
    assert.equal(cleared.session.clearedReason, 'ws-close');
    assert.deepEqual(state.getStatus(), { active: false });
    restore();
  });

  test('stale timeout reaps session and invokes callback', () => {
    const { state, restore } = loadState({ CALL_SESSION_STALE_SEC: '1' });
    let staleSession = null;
    state.setOnSessionStale((session) => {
      staleSession = session;
    });

    state.startCall({
      callSid: 'CA111',
      streamSid: 'MZ111',
      wsConnection: {},
    });

    const now = Date.now;
    Date.now = () => now() + 2000;
    try {
      state._reapStaleSession();
    } finally {
      Date.now = now;
    }

    assert.ok(staleSession);
    assert.equal(staleSession.callSid, 'CA111');
    assert.equal(staleSession.clearedReason, 'stale-timeout');
    assert.deepEqual(state.getStatus(), { active: false });
    restore();
  });
});
