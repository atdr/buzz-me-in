'use strict';

// Behaviour guard for the deferred hangup in homekit.js.
//
// Closing the HomeKit live view sends a STOP, which used to hang up the Twilio
// call at once. That made the room-view route to the lock tile a dead end: the
// stream is torn down on the way out, and the lock had no call left to send
// DTMF to. The call is now held open for config.homekitHangupGraceMs.
//
// This is worth a real test rather than a source assertion. The failure mode is
// a timer that stops firing, or fires when it should have been cancelled, and
// neither is visible in the source once the wiring looks right. It is also the
// unlock path, so the cost of a silent regression is someone stuck outside.
//
// Real timers, with the grace period turned down by env, rather than
// node:test's mock timers — those changed API shape across the Node 20/22/24
// range this repo supports in CI.

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyEnv } = require('./helpers/env.cjs');

const GRACE_MS = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// hangUpCall is destructured at homekit.js module scope, so the stub has to be
// in place before that require runs.
const hangUps = [];
const twilioApiPath = require.resolve('../twilio-api.js');
require.cache[twilioApiPath] = {
  id: twilioApiPath,
  filename: twilioApiPath,
  path: require('node:path').dirname(twilioApiPath),
  loaded: true,
  children: [],
  paths: [],
  exports: {
    hangUpCall: (callSid) => {
      hangUps.push(callSid);
      return Promise.resolve({ alreadyEnded: false });
    },
  },
};

const restoreEnv = applyEnv({
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
  HOMEKIT_HANGUP_GRACE_MS: String(GRACE_MS),
  LOG_LEVEL: 'error',
});

// homekit.js must be evicted too, not just its dependencies. The coverage run
// preloads it through --require, so without this the require below returns the
// already-cached module with the real hangUpCall bound and the stub above is
// silently ignored — which is exactly how this test first shipped, passing
// under `npm test` and failing under `npm run coverage`.
for (const module of ['../src/core/config', '../src/core/state', '../homekit.js']) {
  delete require.cache[require.resolve(module)];
}
const state = require('../src/core/state');
const homekit = require('../homekit.js');
restoreEnv();

// homekit.js reads the active call through the state singleton on every use,
// so shadowing the method is enough to drive it.
let activeCall = null;
state.getActiveCall = () => activeCall;

function reset(callSid) {
  homekit.cancelPendingHangUp('test-reset');
  hangUps.length = 0;
  activeCall = callSid ? { callSid } : null;
}

/**
 * Poll rather than sleep a fixed time, so a loaded runner makes the test slow
 * instead of red. Only for the assertions that expect a hangup; "must not hang
 * up" still has to wait out the full window.
 */
async function waitForHangUp(timeoutMs = GRACE_MS * 8) {
  const deadline = Date.now() + timeoutMs;
  while (hangUps.length === 0 && Date.now() < deadline) await sleep(10);
  return hangUps;
}

test('the twilio-api stub is actually in force', async () => {
  // If homekit.js was loaded before this file installed the stub, every
  // assertion about hangUps silently passes or fails for the wrong reason.
  // Prove the wiring before trusting anything below it.
  reset('CA-wiring');
  homekit.scheduleHangUp('CA-wiring', 'session-wiring');
  assert.deepEqual(
    await waitForHangUp(),
    ['CA-wiring'],
    'hangUpCall is not the stub; homekit.js was loaded before the cache was seeded'
  );
});

test('the call survives the live view closing, then is hung up', async () => {
  reset('CA-still-there');
  homekit.scheduleHangUp('CA-still-there', 'session-1');

  // The whole point: the lock tile is reachable in this window.
  await sleep(GRACE_MS / 2);
  assert.deepEqual(hangUps, [], 'the call must outlive the live view by the grace period');

  assert.deepEqual(
    await waitForHangUp(),
    ['CA-still-there'],
    'the call must still be hung up afterwards'
  );
});

test('reopening the live view cancels the pending hangup', async () => {
  reset('CA-reopened');
  homekit.scheduleHangUp('CA-reopened', 'session-1');
  homekit.cancelPendingHangUp('homekit-session-restarted');

  await sleep(GRACE_MS * 2);
  assert.deepEqual(hangUps, [], 'a reopened live view must not be hung up underneath the user');
});

test('unlocking restarts the window so the digits are not cut off', async () => {
  reset('CA-unlocked');
  homekit.scheduleHangUp('CA-unlocked', 'session-1');

  // Tapping unlock late in the window is exactly the case this protects.
  await sleep(GRACE_MS * 0.66);
  homekit.deferPendingHangUp('unlock-sent');

  // Past the original deadline. Firing here would truncate the DTMF.
  await sleep(GRACE_MS * 0.66);
  assert.deepEqual(hangUps, [], 'unlock must buy a fresh window, not inherit the old deadline');

  assert.deepEqual(
    await waitForHangUp(),
    ['CA-unlocked'],
    'the restarted window must still end the call'
  );
});

test('a call that ended during the window is left alone', async () => {
  reset('CA-gone');
  homekit.scheduleHangUp('CA-gone', 'session-1');
  activeCall = null; // caller hung up first

  await sleep(GRACE_MS * 2);
  assert.deepEqual(hangUps, [], 'hanging up a call that already ended is a pointless REST call');
});

test('a different call in the slot is never hung up', async () => {
  // The slot holds one call at a time, so a new caller can arrive inside the
  // window of the previous one. Hanging that one up would drop a live call.
  reset('CA-first');
  homekit.scheduleHangUp('CA-first', 'session-1');
  activeCall = { callSid: 'CA-second' };

  await sleep(GRACE_MS * 2);
  assert.deepEqual(hangUps, [], 'the pending hangup must be pinned to the call that scheduled it');
});

test('scheduling twice leaves only one pending hangup', async () => {
  reset('CA-rescheduled');
  homekit.scheduleHangUp('CA-rescheduled', 'session-1');
  homekit.scheduleHangUp('CA-rescheduled', 'session-2');

  await waitForHangUp();
  // Give any duplicate timer the same chance to fire before counting.
  await sleep(GRACE_MS);
  assert.deepEqual(hangUps, ['CA-rescheduled'], 'a superseded timer must not fire as well');
});

test('shutdown drops a pending hangup', async () => {
  reset('CA-shutdown');
  homekit.scheduleHangUp('CA-shutdown', 'session-1');
  homekit.shutdown();

  await sleep(GRACE_MS * 2);
  assert.deepEqual(hangUps, [], 'a hangup must not fire against a process that is going away');
});
