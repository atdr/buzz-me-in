'use strict';

// Loaded via `--require` by the `coverage` npm script only.
//
// V8 reports nothing at all for a file no test ever loads, rather than
// reporting it at 0%, so a shipped module that no test requires would vanish
// from the report instead of scoring badly in it. Requiring them here puts them
// back. All three load `config` at module scope, so they need a full valid env
// — which is then removed again, so the suite still runs against the clean
// environment `DOTENV_CONFIG_PATH=/dev/null` guarantees.
//
// This only works because neither entry point acts at module scope any more:
// server.js does its listening, signal handling and CLI parsing inside main(),
// and homekit.js publishes the accessory and spawns ffmpeg inside start(),
// both gated on `require.main === module`. Before that split, requiring either
// one bound a port or advertised an accessory and hung the test runner on open
// handles. tests/coverage.test.cjs guards the split.

const { applyEnv } = require('./env.cjs');

const COVERAGE_ENV = {
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

const restore = applyEnv(COVERAGE_ENV);
try {
  require('../../twilio-api.js');
  require('../../homekit.js');
  require('../../server.js');
} finally {
  restore();
  // The suite loads config itself, with its own env per test. Leaving this
  // module cached would hand those tests the values set above.
  delete require.cache[require.resolve('../../src/core/config')];
}
