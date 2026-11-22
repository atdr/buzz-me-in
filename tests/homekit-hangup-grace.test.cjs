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
//
// The START tests at the end share this file because they need the same
// stubbed homekit.js, and because what a session ending does to the call is
// the hangup decision again: a failed START must leave the call alone.

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

// child_process.spawn is destructured at homekit.js module scope as well, so
// it is replaced before that require too. Anything other than ffmpeg goes to
// the real spawn. Each ffmpeg spawn takes the next entry from spawnPlan:
//   'run'     a real, idle child process standing in for a healthy ffmpeg
//   'missing' a real spawn of a binary that does not exist, so Node reports
//             ENOENT exactly as it does with ffmpeg missing from PATH
//   'throw'   spawn() itself throws synchronously
// Real children rather than EventEmitter fakes, so the order of 'spawn',
// 'error' and 'close' is Node's own and not an assumption baked into a fake.
const childProcess = require('node:child_process');
const realSpawn = childProcess.spawn;
/** @type {Array<'run' | 'missing' | 'throw'>} */
const spawnPlan = [];
/** @type {Array<{ mode: string, args: string[], child: import('node:child_process').ChildProcess }>} */
const spawned = [];
/** How many stand-in children have emitted 'spawn' so far. */
let spawnEvents = 0;
childProcess.spawn = /** @type {any} */ (
  (command, args, options) => {
    if (command !== 'ffmpeg') return realSpawn(command, args, options);
    const mode = spawnPlan.shift() || 'run';
    if (mode === 'throw') throw new Error('spawn rejected its arguments');
    const child =
      mode === 'missing'
        ? realSpawn('buzz-me-in-test-no-such-ffmpeg', args)
        : realSpawn(process.execPath, [
            '-e',
            'process.stdin.resume(); setInterval(() => {}, 1000);',
          ]);
    // Registered before homekit.js attaches its own listener, so this count
    // is already up to date when homekit.js reacts to the same event.
    child.once('spawn', () => spawnEvents++);
    spawned.push({ mode, args, child });
    everySpawned.add(child);
    return child;
  }
);
// A stand-in child left running keeps this file's event loop alive, so a
// regression that leaks one would hang the run instead of failing it.
/** @type {Set<import('node:child_process').ChildProcess>} */
const everySpawned = new Set();
test.after(() => {
  for (const child of everySpawned) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

// warn and error lines are captured rather than printed, so the tests can
// assert on the events homekit.js emits without the run filling with them.
/** @type {Array<Record<string, any>>} */
const logLines = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = /** @type {any} */ (
  (chunk, ...rest) => {
    const text = String(chunk);
    try {
      const line = JSON.parse(text);
      if (line && typeof line.event === 'string') {
        logLines.push(line);
        return true;
      }
    } catch {}
    return realStderrWrite(chunk, ...rest);
  }
);

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
  LOG_LEVEL: 'warn',
});

// homekit.js must be evicted too, not just its dependencies. The coverage run
// preloads it through --require, so without this the require below returns the
// already-cached module with the real hangUpCall bound and the stub above is
// silently ignored — which is exactly how this test first shipped, passing
// under `npm test` and failing under `npm run coverage`.
for (const module of [
  '../src/core/config',
  '../src/core/log',
  '../src/core/state',
  '../homekit.js',
]) {
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

// ---------------------------------------------------------------------------
// Through _stopSession, the path the live bug was actually on.
//
// 2026-09-12: calls died three seconds into the stream. HomeKit runs up to
// cameraStreamCount sessions at once and starts a second one when you move
// between the room view's camera tile and the full camera view. The STOP for
// that second session scheduled a hangup while the first was still streaming.
// Driving scheduleHangUp directly, as the cases above do, cannot see this: the
// fault was in whether to schedule at all, not in the timer.
// ---------------------------------------------------------------------------

/** A session bare enough for _stopSession: no ffmpeg, no SDP to clean up. */
function fakeSession(id) {
  homekit.activeSessions.set(id, {});
  return id;
}

test('a stop with another session still streaming does not end the call', async () => {
  reset('CA-two-sessions');
  fakeSession('session-a');
  fakeSession('session-b');

  homekit._stopSession('session-b', /* hangUp= */ true);

  await sleep(GRACE_MS * 2);
  assert.deepEqual(hangUps, [], 'the surviving session is still streaming; the call must live');
  assert.equal(homekit.activeSessions.size, 1, 'only the stopped session should be gone');

  homekit.activeSessions.clear();
});

test('the last session stopping does end the call', async () => {
  reset('CA-last-session');
  fakeSession('session-only');

  homekit._stopSession('session-only', /* hangUp= */ true);

  assert.deepEqual(
    await waitForHangUp(),
    ['CA-last-session'],
    'with no sessions left the user is finished and the call must end'
  );
});

test('stopping every session in turn ends the call exactly once', async () => {
  reset('CA-drain');
  fakeSession('session-a');
  fakeSession('session-b');

  homekit._stopSession('session-a', /* hangUp= */ true);
  homekit._stopSession('session-b', /* hangUp= */ true);

  await waitForHangUp();
  await sleep(GRACE_MS);
  assert.deepEqual(hangUps, ['CA-drain'], 'draining the sessions must not hang up twice');
});

test('a caller-initiated teardown never hangs up, whatever is streaming', async () => {
  // endHapSession runs on the Twilio stop: the call is already gone.
  reset('CA-caller-left');
  fakeSession('session-a');
  fakeSession('session-b');

  homekit.endHapSession();

  await sleep(GRACE_MS * 2);
  assert.deepEqual(hangUps, [], 'the caller hung up; there is nothing left to hang up');
  assert.equal(homekit.activeSessions.size, 0, 'endHapSession must drain every session');
});

test('the media stream is told only when the last session ends', async () => {
  // Same rule as the hangup: a stop while another session is still streaming
  // must not turn forwarding off, or the surviving live view goes silent.
  reset('CA-ended-notify');
  const ended = [];
  homekit.setOnHapSessionEnded((callSid) => ended.push(callSid));
  fakeSession('session-a');
  fakeSession('session-b');

  homekit._stopSession('session-a', /* hangUp= */ true);
  assert.deepEqual(ended, [], 'session-b is still streaming and still needs audio');

  homekit._stopSession('session-b', /* hangUp= */ true);
  assert.deepEqual(ended, ['CA-ended-notify'], 'the last session ending stops forwarding');

  homekit.setOnHapSessionEnded(null);
  homekit.cancelPendingHangUp('test-cleanup');
});

// ---------------------------------------------------------------------------
// START: ffmpeg spawn failures (#154)
//
// Node reports a failed spawn as an asynchronous 'error' event on the child.
// With no listener that event is rethrown, reaches server.js's
// uncaughtException handler and exits the process, dropping the call: a
// missing ffmpeg turned "open the live view" into "lose the visitor". If a
// listener goes missing again, the ENOENT below is an uncaught exception and
// this file fails outright.
// ---------------------------------------------------------------------------

const fs = require('node:fs');

/** A session record as prepareStreamSession leaves it, ready for START. */
function preparedSession(id) {
  homekit.activeSessions.set(id, {
    targetAddress: '127.0.0.1',
    hkVideoPort: 51368,
    hkVideoKey: Buffer.alloc(16, 1),
    hkVideoSalt: Buffer.alloc(14, 2),
    hkAudioPort: 59947,
    hkAudioKey: Buffer.alloc(16, 3),
    hkAudioSalt: Buffer.alloc(14, 4),
    returnAudioPort: 50000,
    returnAudioKey: Buffer.alloc(16, 3),
    returnAudioSalt: Buffer.alloc(14, 4),
    videoSsrc: 724732488,
    audioSsrc: 1084775967,
  });
  return id;
}

/**
 * Send HomeKit's START for `id` and collect every callback invocation. Resolves
 * on the first one; callers wait a little longer to catch a second.
 */
function sendStart(id) {
  /** @type {Array<Error | undefined>} */
  const calls = [];
  const first = new Promise((resolve) => {
    homekit.streamingDelegate.handleStreamRequest(
      {
        sessionID: id,
        type: 'start',
        video: { max_bit_rate: 299, mtu: 1378, fps: 15, pt: 99 },
        audio: { pt: 110 },
      },
      (error) => {
        calls.push(error);
        resolve(undefined);
      }
    );
  });
  return { calls, first };
}

/** Resolves once `child` has exited, whichever way it went. */
function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve(undefined)));
}

/** The SDP path the outbound leg was spawned with. */
function sdpPathOf(entry) {
  return entry.args[entry.args.indexOf('-i') + 1];
}

function resetStart() {
  spawnPlan.length = 0;
  spawned.length = 0;
  spawnEvents = 0;
  logLines.length = 0;
}

test('a missing ffmpeg fails the START once and leaves the process up', async () => {
  reset('CA-no-ffmpeg');
  resetStart();
  const started = [];
  homekit.setOnHapSessionStarted((callSid) => started.push(callSid));
  spawnPlan.push('missing', 'run');
  preparedSession('session-no-ffin');

  const { calls, first } = sendStart('session-no-ffin');
  await first;
  await sleep(50);

  assert.equal(calls.length, 1, 'HomeKit must get exactly one answer to its START');
  assert.ok(
    calls[0] instanceof Error,
    'the START must fail, not report a stream that is not there'
  );
  assert.equal(calls[0].code, 'ENOENT');
  assert.equal(
    homekit.activeSessions.has('session-no-ffin'),
    false,
    'the session must be forgotten'
  );
  assert.deepEqual(started, [], 'a failed START must not tell the media stream a live view opened');

  const [ffIn, ffOut] = spawned;
  await exited(ffOut.child);
  assert.equal(ffOut.child.signalCode, 'SIGINT', 'the leg that did start must be stopped');
  assert.equal(fs.existsSync(sdpPathOf(ffOut)), false, 'the SDP holds SRTP keys and must go');
  assert.equal(ffIn.mode, 'missing');

  const failed = logLines.filter((l) => l.event === 'stream-start-failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason, 'ffin-spawn-failed');
  assert.equal(failed[0].level, 'error');
  assert.equal(failed[0].sessionId, 'session-no-ffin');

  // The call is untouched: the resident can still unlock from the lock tile.
  await sleep(GRACE_MS * 2);
  assert.deepEqual(hangUps, [], 'a failed START must not hang up the call');
  homekit.setOnHapSessionStarted(null);
});

test('an outbound spawn failure fails the START and stops the inbound leg', async () => {
  reset('CA-no-ffout');
  resetStart();
  spawnPlan.push('run', 'missing');
  preparedSession('session-no-ffout');

  const { calls, first } = sendStart('session-no-ffout');
  await first;
  await sleep(50);

  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof Error);
  assert.equal(homekit.activeSessions.has('session-no-ffout'), false);

  const [ffIn, ffOut] = spawned;
  await exited(ffIn.child);
  assert.equal(ffIn.child.signalCode, 'SIGINT', 'the inbound ffmpeg must not leak');
  assert.equal(fs.existsSync(sdpPathOf(ffOut)), false);
  assert.deepEqual(
    logLines.filter((l) => l.event === 'stream-start-failed').map((l) => l.reason),
    ['ffout-spawn-failed']
  );
});

test('both legs failing to spawn still answers HomeKit only once', async () => {
  reset('CA-no-ffmpeg-at-all');
  resetStart();
  spawnPlan.push('missing', 'missing');
  preparedSession('session-none');

  const { calls, first } = sendStart('session-none');
  await first;
  await sleep(50);

  assert.equal(calls.length, 1, 'the second error must not call back again');
  assert.ok(calls[0] instanceof Error);
  assert.equal(logLines.filter((l) => l.event === 'stream-start-failed').length, 1);
  assert.equal(homekit.activeSessions.size, 0);
});

test('a synchronous spawn throw fails the START the same way', async () => {
  reset('CA-spawn-throws');
  resetStart();
  spawnPlan.push('run', 'throw');
  preparedSession('session-throws');

  const { calls, first } = sendStart('session-throws');
  await first;
  await sleep(50);

  assert.equal(calls.length, 1);
  assert.match(String(calls[0] && calls[0].message), /spawn rejected/);
  assert.equal(homekit.activeSessions.has('session-throws'), false);
  await exited(spawned[0].child);
  assert.equal(spawned[0].child.signalCode, 'SIGINT');
  assert.deepEqual(
    logLines.filter((l) => l.event === 'stream-start-failed').map((l) => l.reason),
    ['session-setup-threw']
  );
});

test('a START whose legs both spawn succeeds once both are running', async () => {
  reset('CA-healthy');
  resetStart();
  const started = [];
  const spawnedWhenStarted = [];
  homekit.setOnHapSessionStarted((callSid) => {
    started.push(callSid);
    spawnedWhenStarted.push(spawnEvents);
  });
  preparedSession('session-healthy');

  const { calls, first } = sendStart('session-healthy');
  let spawnedWhenAnswered = -1;
  first.then(() => (spawnedWhenAnswered = spawnEvents));
  assert.deepEqual(calls, [], 'START must not be answered before either leg has spawned');
  await first;
  await sleep(50);

  assert.deepEqual(calls, [undefined], 'a healthy START is answered once, without an error');
  assert.deepEqual(started, ['CA-healthy']);
  assert.deepEqual(spawnedWhenStarted, [2], 'the media stream is told only once both legs spawned');
  assert.equal(spawnedWhenAnswered, 2, 'HomeKit is answered only once both legs spawned');
  for (const { child } of spawned) assert.ok(child.pid, 'both legs must be running');
  const session = homekit.activeSessions.get('session-healthy');
  assert.equal(session.ffIn, spawned[0].child);
  assert.equal(session.ffOut, spawned[1].child);
  assert.deepEqual(
    logLines.filter((l) => l.event === 'stream-start-failed'),
    []
  );

  homekit._stopSession('session-healthy', /* hangUp= */ false);
  await Promise.all(spawned.map(({ child }) => exited(child)));
  homekit.setOnHapSessionStarted(null);
});

test('a failed START that leaves no session tells the media stream the view is gone', async () => {
  // Session A is live and the Home app has prepared B. A stops while B is
  // still in the map, so _stopSession skips onHapSessionEnded. If B then
  // fails to spawn, failStart is the last chance to send it; without it the
  // media stream keeps forwarding Twilio audio into a buffer nobody reads.
  reset('CA-replacement');
  resetStart();
  const ended = [];
  homekit.setOnHapSessionEnded((callSid) => ended.push(callSid));
  preparedSession('session-a-live');
  const a = sendStart('session-a-live');
  await a.first;
  assert.deepEqual(a.calls, [undefined]);

  preparedSession('session-b-replacement');
  homekit._stopSession('session-a-live', /* hangUp= */ true);
  assert.deepEqual(ended, [], 'B is still prepared, so A stopping is not the last session');
  homekit.cancelPendingHangUp('test-isolate-start-failure');

  spawnPlan.push('missing', 'run');
  const b = sendStart('session-b-replacement');
  await b.first;
  assert.ok(b.calls[0] instanceof Error, 'B must fail its START');
  assert.equal(homekit.activeSessions.size, 0);
  assert.deepEqual(ended, ['CA-replacement'], 'the media stream must be told no view is left');

  await Promise.all(spawned.map(({ child }) => exited(child)));
  await sleep(GRACE_MS * 2);
  assert.deepEqual(hangUps, [], 'a failed START must not hang up the call');
  homekit.setOnHapSessionEnded(null);
});

test('an ffmpeg error after the START was answered ends the session, not the START', async () => {
  // A child can still emit 'error' once running (a failed kill, for one).
  // HomeKit has already been told the stream is up, so calling back again is
  // wrong; the session is over instead.
  reset('CA-late-error');
  resetStart();
  preparedSession('session-late-error');

  const { calls, first } = sendStart('session-late-error');
  await first;
  const [ffIn, ffOut] = spawned;
  ffIn.child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
  await exited(ffOut.child);
  await sleep(50);

  assert.deepEqual(calls, [undefined], 'the START callback must not fire a second time');
  assert.equal(homekit.activeSessions.has('session-late-error'), false);
  assert.equal(ffOut.child.signalCode, 'SIGINT', 'the surviving leg must be stopped');
  assert.equal(fs.existsSync(sdpPathOf(ffOut)), false);
  const ended = logLines.filter((l) => l.event === 'stream-ended-unexpectedly');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].reason, 'ffin-process-error');
  assert.equal(ended[0].level, 'warn');
  assert.deepEqual(
    logLines.filter((l) => l.event === 'stream-start-failed'),
    []
  );
  ffIn.child.kill('SIGKILL');
  await exited(ffIn.child);
});
