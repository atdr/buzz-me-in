const test = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, freshRequire } = require('./helpers/env.cjs');

const BASE_ENV = {
  TWILIO_ACCOUNT_SID: 'AC12345678901234567890123456789012',
  TWILIO_AUTH_TOKEN: 'authtoken-example',
  TWILIO_PHONE_NUMBER: '+15551234567',
  PORT: '8080',
  TUNNEL_HOSTNAME: 'intercom.example.com',
  STREAM_AUTH_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  STATUS_API_TOKEN: '0123456789abcdef',
  HAP_USERNAME: 'AA:BB:CC:DD:EE:11',
  HAP_PINCODE: '123-45-678',
  HAP_PORT: '47129',
};

test('config loads valid configuration and defaults', () => {
  withEnv(BASE_ENV, () => {
    const config = freshRequire('../../src/core/config.js');
    assert.equal(config.port, 8080);
    assert.equal(config.tunnelHostname, 'intercom.example.com');
    assert.equal(config.twilioWebhookBaseUrl, 'https://intercom.example.com');
    assert.equal(config.callSessionStaleSec, 900);
    assert.equal(config.wsMaxMessageBytes, 4096);
    assert.equal(config.twilioMediaPayloadMaxBytes, 512);
    assert.equal(config.shutdownGraceMs, 10000);
  });
});

test('config rejects missing required variables', () => {
  withEnv({ ...BASE_ENV, STATUS_API_TOKEN: undefined }, () => {
    assert.throws(() => freshRequire('../../src/core/config.js'), /STATUS_API_TOKEN/);
  });
});

test('config rejects malformed Twilio account SID', () => {
  withEnv({ ...BASE_ENV, TWILIO_ACCOUNT_SID: 'bad-sid' }, () => {
    assert.throws(() => freshRequire('../../src/core/config.js'), /TWILIO_ACCOUNT_SID/);
  });
});

test('config rejects non-positive integer tuning value', () => {
  withEnv({ ...BASE_ENV, WS_MAX_MESSAGE_BYTES: '0' }, () => {
    assert.throws(() => freshRequire('../../src/core/config.js'), /WS_MAX_MESSAGE_BYTES/);
  });
});
