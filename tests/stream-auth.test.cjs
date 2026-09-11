const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withEnv, freshRequire } = require('./helpers/env.cjs');

const STREAM_AUTH_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const BASE_ENV = {
  TWILIO_ACCOUNT_SID: 'AC12345678901234567890123456789012',
  TWILIO_AUTH_TOKEN: 'authtoken-example',
  TWILIO_PHONE_NUMBER: '+15551234567',
  PORT: '8080',
  TUNNEL_HOSTNAME: 'intercom.example.com',
  STREAM_AUTH_SECRET,
  STATUS_API_TOKEN: '0123456789abcdef',
  HAP_USERNAME: 'AA:BB:CC:DD:EE:11',
  HAP_PINCODE: '123-45-678',
  HAP_PORT: '47129',
};

// stream-auth caches config at load time, so reload both per test for a
// clean nonce store and config bound to BASE_ENV.
function loadStreamAuth() {
  delete require.cache[require.resolve('../src/core/config.js')];
  return freshRequire('../../src/core/stream-auth.js');
}

function toBase64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// Forge a token signed with the real secret but never issued by the module.
function signPayload(payload) {
  const payloadEncoded = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = toBase64Url(
    crypto.createHmac('sha256', STREAM_AUTH_SECRET).update(payloadEncoded).digest()
  );
  return `${payloadEncoded}.${signature}`;
}

// Twilio's scheme: HMAC-SHA1 over the URL with sorted params appended. The
// handshake has no body and no query string, so it is the bare URL.
function twilioSignature(url, authToken = BASE_ENV.TWILIO_AUTH_TOKEN) {
  return crypto.createHmac('sha1', authToken).update(url).digest('base64');
}

test('stream token verification', async (t) => {
  await t.test('issued token verifies once and returns the callSid', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const token = auth.issueStreamToken('CA0123456789');
      const result = auth.verifyAndConsumeStreamToken(token);
      assert.deepEqual(result, { ok: true, callSid: 'CA0123456789' });
    });
  });

  await t.test('token issued without a callSid verifies with callSid null', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const token = auth.issueStreamToken(null);
      const result = auth.verifyAndConsumeStreamToken(token);
      assert.deepEqual(result, { ok: true, callSid: null });
    });
  });

  await t.test('replayed token is rejected after first consumption', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const token = auth.issueStreamToken('CA0123456789');
      assert.equal(auth.verifyAndConsumeStreamToken(token).ok, true);
      const replay = auth.verifyAndConsumeStreamToken(token);
      assert.deepEqual(replay, { ok: false, reason: 'nonce not pending' });
    });
  });

  await t.test('missing and malformed tokens are rejected', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      assert.deepEqual(auth.verifyAndConsumeStreamToken(''), {
        ok: false,
        reason: 'missing token',
      });
      assert.deepEqual(auth.verifyAndConsumeStreamToken('no-separator'), {
        ok: false,
        reason: 'invalid token format',
      });
    });
  });

  await t.test('tampered signature is rejected', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const token = auth.issueStreamToken('CA0123456789');
      const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
      const result = auth.verifyAndConsumeStreamToken(flipped);
      assert.deepEqual(result, { ok: false, reason: 'invalid token signature' });
    });
  });

  await t.test('tampered payload invalidates the signature', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const token = auth.issueStreamToken('CA0123456789');
      const [payloadEncoded, signature] = token.split('.');
      const payload = JSON.parse(Buffer.from(payloadEncoded, 'base64').toString('utf8'));
      payload.callSid = 'CAattacker';
      const forgedPayload = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
      const result = auth.verifyAndConsumeStreamToken(`${forgedPayload}.${signature}`);
      assert.deepEqual(result, { ok: false, reason: 'invalid token signature' });
    });
  });

  await t.test('validly signed token with unknown nonce is rejected', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const now = Math.floor(Date.now() / 1000);
      const forged = signPayload({
        v: 1,
        iat: now,
        exp: now + 60,
        nonce: 'deadbeefdeadbeefdeadbeefdeadbeef',
        callSid: 'CA0123456789',
      });
      const result = auth.verifyAndConsumeStreamToken(forged);
      assert.deepEqual(result, { ok: false, reason: 'nonce not pending' });
    });
  });

  await t.test('wrong token version is rejected', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const now = Math.floor(Date.now() / 1000);
      const forged = signPayload({
        v: 2,
        iat: now,
        exp: now + 60,
        nonce: 'deadbeefdeadbeefdeadbeefdeadbeef',
        callSid: 'CA0123456789',
      });
      const result = auth.verifyAndConsumeStreamToken(forged);
      assert.deepEqual(result, { ok: false, reason: 'expired or malformed token' });
    });
  });

  await t.test('expired token is rejected', (t2) => {
    t2.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const token = auth.issueStreamToken('CA0123456789');
      t2.mock.timers.tick(91 * 1000); // past the 90 s TTL
      const result = auth.verifyAndConsumeStreamToken(token);
      assert.deepEqual(result, { ok: false, reason: 'expired or malformed token' });
    });
  });
});

test('connect-stream TwiML builder', async (t) => {
  await t.test('embeds the wss URL and a verifiable one-time token', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const twiml = auth.buildConnectStreamTwiml('CA0123456789');
      assert.match(twiml, /<Connect><Stream url="wss:\/\/intercom\.example\.com\/media">/);
      const match = twiml.match(
        new RegExp(`<Parameter name="${auth.STREAM_TOKEN_PARAMETER_NAME}" value="([^"]+)"/>`)
      );
      assert.ok(match, 'TwiML should contain a token parameter');
      const result = auth.verifyAndConsumeStreamToken(match[1]);
      assert.deepEqual(result, { ok: true, callSid: 'CA0123456789' });
    });
  });
});

test('media handshake signature verification', async (t) => {
  await t.test('accepts the wss URL the TwiML actually advertises', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const url = 'wss://intercom.example.com/media';
      assert.deepEqual(auth.verifyStreamHandshakeSignature(twilioSignature(url)), {
        ok: true,
        signedUrl: url,
      });
    });
  });

  // Twilio's own guidance is to try a trailing slash when validation fails,
  // so a signature over the slashed form must verify and report which
  // variant matched.
  await t.test('accepts the trailing-slash variant and reports it', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const url = 'wss://intercom.example.com/media/';
      assert.deepEqual(auth.verifyStreamHandshakeSignature(twilioSignature(url)), {
        ok: true,
        signedUrl: url,
      });
    });
  });

  // The upgrade arrives over HTTP, so a signature computed against https://
  // must verify too (twilio-aspnet#162).
  await t.test('accepts the https scheme variant', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const url = 'https://intercom.example.com/media';
      assert.deepEqual(auth.verifyStreamHandshakeSignature(twilioSignature(url)), {
        ok: true,
        signedUrl: url,
      });
    });
  });

  await t.test('missing or non-string signature is rejected', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const expected = { ok: false, reason: 'missing handshake signature' };
      assert.deepEqual(auth.verifyStreamHandshakeSignature(undefined), expected);
      assert.deepEqual(auth.verifyStreamHandshakeSignature(''), expected);
      // A repeated header arrives as an array, not a string.
      assert.deepEqual(auth.verifyStreamHandshakeSignature(['a', 'b']), expected);
    });
  });

  await t.test('signature from a different auth token is rejected', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const forged = twilioSignature('wss://intercom.example.com/media', 'not-the-auth-token');
      assert.deepEqual(auth.verifyStreamHandshakeSignature(forged), {
        ok: false,
        reason: 'invalid handshake signature',
      });
    });
  });

  // A signature minted for another tunnel on the same Twilio account must not
  // open this one.
  await t.test('signature for a different hostname is rejected', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const other = twilioSignature('wss://other-intercom.example.com/media');
      assert.deepEqual(auth.verifyStreamHandshakeSignature(other), {
        ok: false,
        reason: 'invalid handshake signature',
      });
    });
  });

  await t.test('signature for a different path is rejected', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const other = twilioSignature('wss://intercom.example.com/twiml');
      assert.deepEqual(auth.verifyStreamHandshakeSignature(other), {
        ok: false,
        reason: 'invalid handshake signature',
      });
    });
  });

  await t.test('an explicit hostname overrides the configured one', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const url = 'wss://elsewhere.example.com/media';
      assert.deepEqual(
        auth.verifyStreamHandshakeSignature(twilioSignature(url), 'elsewhere.example.com'),
        { ok: true, signedUrl: url }
      );
    });
  });

  // Defence in depth only. The handshake carries no body and no query string,
  // so the signature is an HMAC over a constant URL: it is the same on every
  // call and verifying does not consume it. Contrast the stream token above,
  // which is single-use and is the only replay control on /media. If this
  // test ever needs changing, the one-time token must not be what changed.
  await t.test('verification is repeatable, unlike the one-time token', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      const signature = twilioSignature('wss://intercom.example.com/media');
      assert.equal(auth.verifyStreamHandshakeSignature(signature).ok, true);
      assert.equal(auth.verifyStreamHandshakeSignature(signature).ok, true);
    });
  });

  // Pin the candidate set so it cannot silently widen. Every entry has to HMAC
  // to the presented signature under the auth token, but the list is still the
  // full set of URLs a signature may be minted for.
  await t.test('candidate URLs are exactly the four documented variants', () => {
    withEnv(BASE_ENV, () => {
      const auth = loadStreamAuth();
      assert.deepEqual(auth.streamHandshakeSignedUrls(), [
        'wss://intercom.example.com/media',
        'wss://intercom.example.com/media/',
        'https://intercom.example.com/media',
        'https://intercom.example.com/media/',
      ]);
    });
  });
});
