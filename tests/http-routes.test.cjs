'use strict';

// The plain HTTP routes in server.js: the Twilio signature check on /twiml, the
// bearer token on /status, the unauthenticated probes, and the answers for
// everything else.
//
// handleRequest is mounted on a throwaway HTTP server on an ephemeral port, so
// nothing here binds PORT or publishes the HomeKit accessory. Each case loads
// server.js fresh, because the shutting-down flag lives at its module scope.
// Requests are signed with the Twilio SDK's own helper, never a hand-rolled
// HMAC.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const twilio = require('twilio');
const { withEnv, freshRequire } = require('./helpers/env.cjs');

const AUTH_TOKEN = 'test_auth_token';
const WEBHOOK_BASE_URL = 'https://intercom.example.com';
const STATUS_TOKEN = '1234567890abcdef';
const BODY_LIMIT = 32 * 1024;

const BASE_ENV = {
  TWILIO_ACCOUNT_SID: 'AC12345678901234567890123456789012',
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: '+15551234567',
  PORT: '8080',
  TUNNEL_HOSTNAME: 'intercom.example.com',
  TWILIO_WEBHOOK_BASE_URL: WEBHOOK_BASE_URL,
  STREAM_AUTH_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  STATUS_API_TOKEN: STATUS_TOKEN,
  HAP_USERNAME: 'AA:BB:CC:DD:EE:11',
  HAP_PINCODE: '123-45-678',
  HAP_PORT: '47129',
  LOG_LEVEL: 'error',
  KNOWN_CALLERS: '',
};

/**
 * Loads server.js with a clean module cache for the modules that read config
 * or hold the shutting-down flag.
 *
 * @param {Record<string, string | undefined>} [overrides]
 * @returns {typeof import('../server.js')}
 */
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

/**
 * Mounts handleRequest on an ephemeral port, closed when the test ends.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string | undefined>} [overrides]
 * @returns {Promise<{ port: number, server: ReturnType<typeof loadServer> }>}
 */
async function listen(t, overrides) {
  const server = loadServer(overrides);
  const httpServer = http.createServer(server.handleRequest);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    httpServer.closeAllConnections();
    httpServer.close();
  });
  const { port } = /** @type {import('net').AddressInfo} */ (httpServer.address());
  return { port, server };
}

/**
 * Sends a request and resolves with the status, headers and body. A connection
 * the server destroys mid-request resolves as `{ error }` instead of rejecting.
 *
 * @param {number} port
 * @param {string} method
 * @param {string} path
 * @param {{ headers?: Record<string, string>, body?: string | Buffer }} [options]
 * @returns {Promise<{ status?: number, headers?: http.IncomingHttpHeaders, body?: string, raw?: Buffer, error?: Error }>}
 */
function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: raw.toString('utf8'), raw });
      });
      res.on('error', (error) => resolve({ error }));
    });
    req.on('error', (error) => resolve({ error }));
    req.end(body);
  });
}

/**
 * POSTs a form to /twiml, signed by the SDK against `signedUrl`.
 *
 * @param {number} port
 * @param {Record<string, string | string[]>} params
 * @param {{ path?: string, signedUrl?: string, headers?: Record<string, string> }} [options]
 */
function postTwiml(port, params, { path = '/twiml', signedUrl, headers } = {}) {
  const url = signedUrl || `${WEBHOOK_BASE_URL}${path}`;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of [value].flat()) search.append(key, item);
  }
  return request(port, 'POST', path, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params),
      ...headers,
    },
    body: search.toString(),
  });
}

const CALL_SID = 'CA0123456789abcdef0123456789abcdef';

test('POST /twiml signature check', async (t) => {
  await t.test('answers a correctly signed request with TwiML', async (t) => {
    const { port } = await listen(t);
    const res = await postTwiml(port, { CallSid: CALL_SID, From: '+15557654321' });
    assert.equal(res.status, 200);
    assert.equal(res.headers?.['content-type'], 'text/xml');
    assert.equal(res.headers?.['content-length'], String(Buffer.byteLength(res.body || '')));
    assert.match(res.body || '', /<Response>/);
    assert.match(res.body || '', /<Connect>/);
    assert.match(res.body || '', /\/media/);
  });

  await t.test('403s a request with no signature header', async (t) => {
    const { port } = await listen(t);
    const res = await request(port, 'POST', '/twiml', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `CallSid=${CALL_SID}`,
    });
    assert.equal(res.status, 403);
    assert.equal(res.body, 'Forbidden');
  });

  await t.test('403s an empty signature header', async (t) => {
    const { port } = await listen(t);
    const res = await postTwiml(
      port,
      { CallSid: CALL_SID },
      { headers: { 'x-twilio-signature': '' } }
    );
    assert.equal(res.status, 403);
  });

  await t.test('403s a wrong signature', async (t) => {
    const { port } = await listen(t);
    const res = await postTwiml(
      port,
      { CallSid: CALL_SID },
      { headers: { 'x-twilio-signature': 'bogus' } }
    );
    assert.equal(res.status, 403);
  });

  await t.test('403s a signature made with another auth token', async (t) => {
    const { port } = await listen(t);
    const forged = twilio.getExpectedTwilioSignature(
      'someone_elses_token',
      `${WEBHOOK_BASE_URL}/twiml`,
      {
        CallSid: CALL_SID,
      }
    );
    const res = await postTwiml(
      port,
      { CallSid: CALL_SID },
      { headers: { 'x-twilio-signature': forged } }
    );
    assert.equal(res.status, 403);
  });

  await t.test('403s a body altered after signing', async (t) => {
    const { port } = await listen(t);
    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${WEBHOOK_BASE_URL}/twiml`, {
      CallSid: CALL_SID,
    });
    const res = await request(port, 'POST', '/twiml', {
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
      },
      body: 'CallSid=CAffffffffffffffffffffffffffffffff',
    });
    assert.equal(res.status, 403);
  });
});

test('POST /twiml signed URL', async (t) => {
  await t.test('checks TWILIO_WEBHOOK_BASE_URL + path + query', async (t) => {
    const { port } = await listen(t);
    const ok = await postTwiml(port, { CallSid: CALL_SID }, { path: '/twiml?a=1&b=two' });
    assert.equal(ok.status, 200);
  });

  await t.test('rejects a signature that omits the query string', async (t) => {
    const { port } = await listen(t);
    const res = await postTwiml(
      port,
      { CallSid: CALL_SID },
      { path: '/twiml?a=1', signedUrl: `${WEBHOOK_BASE_URL}/twiml` }
    );
    assert.equal(res.status, 403);
  });

  await t.test('rejects a signature made against the Host header instead', async (t) => {
    const { port } = await listen(t);
    const res = await postTwiml(
      port,
      { CallSid: CALL_SID },
      { signedUrl: `http://127.0.0.1:${port}/twiml` }
    );
    assert.equal(res.status, 403);
  });

  await t.test('uses a configured base URL that differs from the tunnel hostname', async (t) => {
    const base = 'https://webhooks.example.org';
    const { port } = await listen(t, { TWILIO_WEBHOOK_BASE_URL: base });
    const ok = await postTwiml(port, { CallSid: CALL_SID }, { signedUrl: `${base}/twiml` });
    assert.equal(ok.status, 200);
    const stale = await postTwiml(port, { CallSid: CALL_SID });
    assert.equal(stale.status, 403);
  });

  await t.test('ignores a trailing slash on the configured base URL', async (t) => {
    const { port } = await listen(t, { TWILIO_WEBHOOK_BASE_URL: `${WEBHOOK_BASE_URL}/` });
    const res = await postTwiml(port, { CallSid: CALL_SID });
    assert.equal(res.status, 200);
  });
});

test('POST /twiml body handling', async (t) => {
  await t.test('accepts a body of exactly the 32 KB limit', async (t) => {
    const { port } = await listen(t);
    const filler = 'x'.repeat(BODY_LIMIT - 'CallSid=&Pad='.length - CALL_SID.length);
    const params = { CallSid: CALL_SID, Pad: filler };
    assert.equal(new URLSearchParams(params).toString().length, BODY_LIMIT);
    const res = await postTwiml(port, params);
    assert.equal(res.status, 200);
  });

  await t.test('400s a body over the limit, even when correctly signed', async (t) => {
    const { port } = await listen(t);
    const params = { CallSid: CALL_SID, Pad: 'x'.repeat(BODY_LIMIT) };
    const res = await postTwiml(port, params);
    // readRequestBody destroys the request once the limit is passed, so the
    // client may see the 400 or a reset connection depending on timing. It must
    // never see the TwiML.
    if (res.error) return;
    assert.equal(res.status, 400);
    assert.equal(res.body, 'Invalid request body');
  });

  await t.test('survives an oversized body and keeps serving', async (t) => {
    const { port } = await listen(t);
    await postTwiml(port, { CallSid: CALL_SID, Pad: 'x'.repeat(BODY_LIMIT * 2) });
    const res = await request(port, 'GET', '/healthz');
    assert.equal(res.status, 200);
  });

  await t.test('answers a signed request with no CallSid', async (t) => {
    const { port } = await listen(t);
    const res = await postTwiml(port, { From: '+15557654321' });
    assert.equal(res.status, 200);
    assert.match(res.body || '', /<Response>/);
  });

  await t.test('answers a signed request with an empty body', async (t) => {
    const { port } = await listen(t);
    const res = await postTwiml(port, {});
    assert.equal(res.status, 200);
  });

  await t.test('accepts a repeated CallSid and From when signed as sent', async (t) => {
    const { port } = await listen(t, { KNOWN_CALLERS: '+15557654321=Alice' });
    const res = await postTwiml(port, {
      CallSid: [CALL_SID, 'CAffffffffffffffffffffffffffffffff'],
      From: ['+15557654321', '+15550000000'],
    });
    assert.equal(res.status, 200);
    assert.match(res.body || '', /<Response>/);
  });

  await t.test('rejects a repeated field whose signature covers only one value', async (t) => {
    const { port } = await listen(t);
    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${WEBHOOK_BASE_URL}/twiml`, {
      CallSid: CALL_SID,
    });
    const res = await request(port, 'POST', '/twiml', {
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
      },
      body: `CallSid=${CALL_SID}&CallSid=CAffffffffffffffffffffffffffffffff`,
    });
    assert.equal(res.status, 403);
  });
});

test('parseFormUrlEncoded and describeCaller', async (t) => {
  await t.test('collects repeated fields into arrays, in order', () => {
    const { parseFormUrlEncoded } = loadServer();
    assert.deepEqual(parseFormUrlEncoded('a=1&a=2&a=3&b=x&c=%2B1'), {
      a: ['1', '2', '3'],
      b: 'x',
      c: '+1',
    });
  });

  await t.test('labels a repeated From by its first value', () => {
    const { describeCaller } = loadServer({ KNOWN_CALLERS: '+15557654321=Alice' });
    assert.equal(describeCaller(['+15557654321', '+15550000000']), 'Alice');
    assert.equal(describeCaller(['+15550000000', '+15557654321']), 'unknown');
  });
});

test('GET /status', async (t) => {
  await t.test('returns the status JSON for the correct bearer token', async (t) => {
    const { port } = await listen(t);
    const res = await request(port, 'GET', '/status', {
      headers: { authorization: `Bearer ${STATUS_TOKEN}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers?.['content-type'], 'application/json');
    assert.equal(typeof JSON.parse(res.body || ''), 'object');
  });

  await t.test('401s a missing token', async (t) => {
    const { port } = await listen(t);
    const res = await request(port, 'GET', '/status');
    assert.equal(res.status, 401);
    assert.equal(res.body, 'Unauthorized');
  });

  await t.test('401s a wrong token, of the same length or a different one', async (t) => {
    const { port } = await listen(t);
    // The same-length token catches a check that compares only lengths.
    const sameLength = 'fedcba0987654321';
    assert.equal(sameLength.length, STATUS_TOKEN.length);
    for (const token of [sameLength, 'wrong', `${STATUS_TOKEN}x`, STATUS_TOKEN.slice(0, -1), '']) {
      const res = await request(port, 'GET', '/status', {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 401, `token ${JSON.stringify(token)}`);
    }
  });

  await t.test('401s the right token under another scheme or case', async (t) => {
    const { port } = await listen(t);
    for (const authorization of [STATUS_TOKEN, `Basic ${STATUS_TOKEN}`, `bearer ${STATUS_TOKEN}`]) {
      const res = await request(port, 'GET', '/status', { headers: { authorization } });
      assert.equal(res.status, 401, authorization);
    }
  });

  await t.test('ignores the query string when routing, and still checks the token', async (t) => {
    const { port } = await listen(t);
    assert.equal((await request(port, 'GET', '/status?x=1')).status, 401);
    const res = await request(port, 'GET', '/status?x=1', {
      headers: { authorization: `Bearer ${STATUS_TOKEN}` },
    });
    assert.equal(res.status, 200);
  });
});

test('unauthenticated GET routes', async (t) => {
  await t.test('/healthz answers {"ok":true} without credentials', async (t) => {
    const { port } = await listen(t);
    const res = await request(port, 'GET', '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.headers?.['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(res.body || ''), { ok: true });
  });

  await t.test('/readyz answers {"ok":true} without credentials', async (t) => {
    const { port } = await listen(t);
    const res = await request(port, 'GET', '/readyz');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body || ''), { ok: true });
  });

  await t.test('/ringtone serves an uncached WAV', async (t) => {
    const { port } = await listen(t);
    const res = await request(port, 'GET', '/ringtone');
    assert.equal(res.status, 200);
    assert.equal(res.headers?.['content-type'], 'audio/wav');
    assert.equal(res.headers?.['cache-control'], 'no-store');
    assert.equal(res.headers?.['content-length'], String(res.raw?.length));
    assert.equal(res.raw?.subarray(0, 4).toString('ascii'), 'RIFF');
  });
});

test('unknown paths and wrong methods', async (t) => {
  await t.test('404s an unknown path', async (t) => {
    const { port } = await listen(t);
    const res = await request(port, 'GET', '/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body, 'Not Found');
  });

  await t.test('404s the root and a near miss of a real path', async (t) => {
    const { port } = await listen(t);
    for (const path of ['/', '/healthz/', '/Healthz', '/twiml/', '/media']) {
      const res = await request(port, 'GET', path);
      assert.equal(res.status, 404, path);
    }
  });

  await t.test('404s GET /twiml, which is POST only', async (t) => {
    const { port } = await listen(t);
    assert.equal((await request(port, 'GET', '/twiml')).status, 404);
  });

  await t.test('404s a non-GET on a GET route, without reaching auth', async (t) => {
    const { port } = await listen(t);
    for (const [method, path] of [
      ['POST', '/status'],
      ['PUT', '/status'],
      ['DELETE', '/healthz'],
      ['POST', '/readyz'],
      ['POST', '/ringtone'],
    ]) {
      const res = await request(port, method, path, {
        headers: { authorization: `Bearer ${STATUS_TOKEN}` },
      });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  });

  await t.test('404s PUT and DELETE on /twiml', async (t) => {
    const { port } = await listen(t);
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      assert.equal((await request(port, method, '/twiml')).status, 404, method);
    }
  });
});

test('while shutting down', async (t) => {
  await t.test('503s every route, before any auth or signature check', async (t) => {
    const server = loadServer();
    // beginShutdown is the only way to set the flag and it ends in
    // process.exit, so the exit, the HomeKit teardown and the force-exit timer
    // are all neutralised first. The exit stub is what keeps a failure here
    // from ending the runner and being reported as a pass.
    const homekit = require(require.resolve('../homekit.js'));
    /** @type {Array<number | undefined>} */
    const exitCalls = [];
    /** @type {() => void} */
    let exited = () => {};
    const exitReached = new Promise((resolve) => (exited = () => resolve(undefined)));
    t.mock.method(process, 'exit', (code) => {
      exitCalls.push(code);
      exited();
    });
    t.mock.method(homekit, 'shutdown', () => {});

    server.beginShutdown('SIGTERM');
    // wsserver was never listening, so close() calls back on the next tick,
    // which clears the force-exit timer and reaches the stubbed exit.
    await exitReached;
    assert.deepEqual(exitCalls, [0]);

    const httpServer = http.createServer(server.handleRequest);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      httpServer.closeAllConnections();
      httpServer.close();
    });
    const { port } = /** @type {import('net').AddressInfo} */ (httpServer.address());

    const probes = [
      request(port, 'GET', '/healthz'),
      request(port, 'GET', '/status'),
      request(port, 'GET', '/nope'),
      postTwiml(port, { CallSid: CALL_SID }),
      request(port, 'POST', '/twiml'),
    ];
    for (const res of await Promise.all(probes)) {
      assert.equal(res.status, 503);
      assert.equal(res.body, 'Server shutting down');
    }
  });
});
