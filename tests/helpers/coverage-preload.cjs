'use strict';

// Loaded via `--require` by the `coverage` npm script only.
//
// V8 reports nothing at all for a file no test ever loads, rather than
// reporting it at 0%, so twilio-api.js would vanish from the report instead of
// scoring badly in it. Requiring it here puts it back. It loads `config` at
// module scope, so it needs a full valid env — which is then removed again, so
// the suite still runs against the clean environment `DOTENV_CONFIG_PATH`
// guarantees.

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
} finally {
  restore();
  delete require.cache[require.resolve('../../src/core/config')];
}
