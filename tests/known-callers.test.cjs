'use strict';

// KNOWN_CALLERS labels the number in the twiml-response log line.
//
// It exists because the journal recorded a call arriving and nothing about who
// made it: on 2026-09-17 an unexpected buzz could not be attributed without
// going to the Twilio console. The number Twilio sends is only trustworthy
// after the signature check, so the label is attached where the call is
// accepted, not where the request arrives.
//
// Deliberately descriptive, never a gate. An unlabelled caller is 'unknown' and
// still rings the doorbell: the building's dialler could change without
// warning, and a silently blocked visitor is far worse than a labelled unknown
// one. If a case here ever starts asserting that an unknown caller is refused,
// that is a change of policy and wants saying out loud.

const test = require('node:test');
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

function loadConfig(knownCallers) {
  return withEnv({ ...BASE_ENV, KNOWN_CALLERS: knownCallers }, () =>
    freshRequire('../../src/core/config.js')
  );
}

function expectFail(knownCallers, match) {
  assert.throws(() => loadConfig(knownCallers), match);
}

test('KNOWN_CALLERS parsing', async (t) => {
  await t.test('unset leaves an empty map rather than throwing', () => {
    const config = loadConfig(undefined);
    assert.equal(config.knownCallers.size, 0);
  });

  await t.test('parses pairs, keeping spaces inside labels', () => {
    const config = loadConfig('+15551234567=Intercom,+15557654321=Building management');
    assert.equal(config.knownCallers.get('+15551234567'), 'Intercom');
    assert.equal(config.knownCallers.get('+15557654321'), 'Building management');
    assert.equal(config.knownCallers.size, 2);
  });

  await t.test('tolerates padding around entries and the separator', () => {
    const config = loadConfig('  +15551234567 = Intercom ,, +15557654321=Gate  ');
    assert.equal(config.knownCallers.get('+15551234567'), 'Intercom');
    assert.equal(config.knownCallers.get('+15557654321'), 'Gate');
  });

  await t.test('keeps a label containing an equals sign intact', () => {
    // Split on the first separator only, or a label like "Gate = side door"
    // silently loses everything after the second one.
    const config = loadConfig('+15551234567=Gate = side door');
    assert.equal(config.knownCallers.get('+15551234567'), 'Gate = side door');
  });

  await t.test('rejects an entry with no separator', () => {
    expectFail('+15551234567', /must be <E.164>=<label>/);
  });

  await t.test('rejects a number that is not E.164', () => {
    expectFail('5551234567=Intercom', /does not start with an E.164 number/);
    expectFail('+0555123=Intercom', /does not start with an E.164 number/);
  });

  await t.test('rejects an empty label', () => {
    expectFail('+15551234567=', /has an empty label/);
    expectFail('+15551234567=   ', /has an empty label/);
  });

  await t.test('rejects an over-long label', () => {
    expectFail(`+15551234567=${'x'.repeat(65)}`, /longer than 64 characters/);
  });

  await t.test('rejects a duplicated number', () => {
    // Otherwise one label silently wins and the other is never seen again.
    expectFail('+15551234567=Intercom,+15551234567=Gate', /more than once/);
  });
});

function loadServer(knownCallers) {
  return withEnv({ ...BASE_ENV, KNOWN_CALLERS: knownCallers, LOG_LEVEL: 'error' }, () => {
    // require.resolve is relative to this file; freshRequire's path is relative
    // to helpers/env.cjs, which is why the two differ.
    for (const module of ['../src/core/config.js', '../homekit.js', '../server.js']) {
      delete require.cache[require.resolve(module)];
    }
    return freshRequire('../../server.js');
  });
}

test('caller labelling in the TwiML log', async (t) => {
  await t.test('names a known caller', () => {
    const server = loadServer('+15551234567=Intercom');
    assert.equal(server.describeCaller('+15551234567'), 'Intercom');
  });

  await t.test('calls anything unlabelled unknown, and still accepts it', () => {
    // 'unknown' is a label, not a verdict. Nothing downstream may branch on it.
    const server = loadServer('+15551234567=Intercom');
    assert.equal(server.describeCaller('+15559999999'), 'unknown');
    assert.equal(server.describeCaller(undefined), 'unknown');
    assert.equal(server.describeCaller(''), 'unknown');
  });

  await t.test('omits the field entirely when nothing is configured', () => {
    // Otherwise every call on an unconfigured deployment reads 'unknown',
    // which looks like a finding rather than an absence of configuration.
    const server = loadServer(undefined);
    assert.equal(server.describeCaller('+15551234567'), null);
    assert.equal(server.describeCaller(undefined), null);
  });

  await t.test('tolerates a repeated From field', () => {
    // A repeated form field parses to an array. The Twilio signature covers
    // the body, not its shape, so this must not throw.
    const server = loadServer('+15551234567=Intercom');
    assert.equal(server.describeCaller(['+15551234567', '+15559999999']), 'Intercom');
    assert.equal(server.describeCaller([]), 'unknown');
  });

  await t.test('trims whitespace around the incoming number', () => {
    const server = loadServer('+15551234567=Intercom');
    assert.equal(server.describeCaller('  +15551234567  '), 'Intercom');
  });
});
