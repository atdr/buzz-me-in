'use strict';

// The /media handshake as Twilio sees it: status codes on refusal, and a
// server that survives whatever a client sends.
//
// handleMediaUpgrade is mounted on a throwaway HTTP server on an ephemeral
// port, so nothing here binds PORT or publishes the HomeKit accessory. Each
// case loads server.js fresh, because the connection set and the ws instance
// live at its module scope.
//
// Not covered: the 503 while shutting down. beginShutdown is the only way to
// set that flag, and it ends in process.exit.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const { PassThrough } = require('stream');
const twilio = require('twilio');
const { WebSocket } = require('ws');
const { withEnv, freshRequire } = require('./helpers/env.cjs');

const AUTH_TOKEN = 'test_auth_token';
const TUNNEL_HOSTNAME = 'intercom.example.com';
const SIGNATURE = twilio.getExpectedTwilioSignature(
  AUTH_TOKEN,
  `wss://${TUNNEL_HOSTNAME}/media`,
  {}
);

const BASE_ENV = {
  TWILIO_ACCOUNT_SID: 'AC12345678901234567890123456789012',
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: '+15551234567',
  PORT: '8080',
  TUNNEL_HOSTNAME,
  STREAM_AUTH_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  STATUS_API_TOKEN: '1234567890abcdef',
  HAP_USERNAME: 'AA:BB:CC:DD:EE:11',
  HAP_PINCODE: '123-45-678',
  HAP_PORT: '47129',
  LOG_LEVEL: 'error',
  TWILIO_MEDIA_SIGNATURE_MODE: 'enforce',
};

function loadServer(overrides = {}) {
  return withEnv({ ...BASE_ENV, ...overrides }, () => {
    // require.resolve is relative to this file; freshRequire's path is relative
    // to helpers/env.cjs, which is why the two differ.
    for (const module of ['../src/core/config.js', '../homekit.js', '../server.js']) {
      delete require.cache[require.resolve(module)];
    }
    return freshRequire('../../server.js');
  });
}

async function listen(t, overrides) {
  const server = loadServer(overrides);
  const httpServer = http.createServer();
  httpServer.on('upgrade', server.handleMediaUpgrade);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    httpServer.closeAllConnections();
    httpServer.close();
  });
  const { port } = /** @type {import('net').AddressInfo} */ (httpServer.address());
  return port;
}

/**
 * Resolves with the HTTP status of a refused handshake, or the open socket.
 */
function connect(port, path, headers = { 'x-twilio-signature': SIGNATURE }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
    ws.on('open', () => resolve({ ws }));
    ws.on('error', reject);
  });
}

/** Sends a raw request and resolves with the status line of the reply. */
function rawStatusLine(port, requestLine) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data.split('\r\n')[0]));
    socket.on('error', reject);
    socket.write(
      `${requestLine}\r\n` +
        'Host: 127.0.0.1\r\n' +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        '\r\n'
    );
  });
}

test('media upgrade handshake', async (t) => {
  await t.test('404s a path other than /media', async (t) => {
    const port = await listen(t);
    assert.deepEqual(await connect(port, '/nope'), { status: 404 });
  });

  await t.test('400s a request target URL cannot parse, and stays up', async (t) => {
    const port = await listen(t);
    assert.equal(await rawStatusLine(port, 'GET http://[ HTTP/1.1'), 'HTTP/1.1 400 Bad Request');
    const { ws } = await connect(port, '/media');
    ws.terminate();
  });

  await t.test('403s a missing or wrong signature in enforce mode', async (t) => {
    const port = await listen(t);
    assert.deepEqual(await connect(port, '/media', {}), { status: 403 });
    assert.deepEqual(await connect(port, '/media', { 'x-twilio-signature': 'bogus' }), {
      status: 403,
    });
  });

  await t.test('lets an unsigned handshake through in log mode', async (t) => {
    const port = await listen(t, { TWILIO_MEDIA_SIGNATURE_MODE: 'log' });
    const { ws } = await connect(port, '/media', {});
    assert.ok(ws);
    ws.terminate();
  });

  await t.test('503s past the connection cap, after the signature check', async (t) => {
    const port = await listen(t, { WS_MAX_CONNECTIONS: '1' });
    const { ws } = await connect(port, '/media');
    // A bad signature still reads 403 while the cap is full: auth comes first.
    assert.deepEqual(await connect(port, '/media', {}), { status: 403 });
    assert.deepEqual(await connect(port, '/media'), { status: 503 });
    ws.terminate();
  });

  await t.test('closes an oversized frame with 1009 and stays up', async (t) => {
    const port = await listen(t, { WS_MAX_MESSAGE_BYTES: '1024' });
    const { ws } = await connect(port, '/media');
    const code = await new Promise((resolve) => {
      ws.on('close', resolve);
      // Over maxPayload (4x WS_MAX_MESSAGE_BYTES), so ws itself raises 'error'.
      ws.send('x'.repeat(8192));
    });
    assert.equal(code, 1009);
    const second = await connect(port, '/media');
    second.ws.terminate();
  });

  await t.test('a socket error during the handshake does not throw', () => {
    const server = loadServer();
    const socket = new PassThrough();
    const request = /** @type {import('http').IncomingMessage} */ (
      /** @type {unknown} */ ({ url: '/nope', headers: {} })
    );
    server.handleMediaUpgrade(request, socket, Buffer.alloc(0));
    assert.doesNotThrow(() => socket.emit('error', new Error('ECONNRESET')));
  });
});
