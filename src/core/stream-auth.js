'use strict';

const crypto = require('crypto');
const twilio = require('twilio');
const config = require('./config');
const { safeEqualString } = require('./safe-equal');

const STREAM_TOKEN_PARAMETER_NAME = 'token';
const STREAM_TOKEN_VERSION = 1;
const STREAM_PATH = '/media';
const pendingStreamNonces = new Map();

function toBase64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function pruneExpiredNonces() {
  const now = Math.floor(Date.now() / 1000);
  for (const [nonce, data] of pendingStreamNonces.entries()) {
    if (data.exp <= now) pendingStreamNonces.delete(nonce);
  }
}

/**
 * @param {string | null} callSid
 * @returns {string}
 */
function issueStreamToken(callSid) {
  pruneExpiredNonces();

  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.streamAuthTtlSec;
  const nonce = crypto.randomBytes(16).toString('hex');

  pendingStreamNonces.set(nonce, { exp, callSid });

  const payload = {
    v: STREAM_TOKEN_VERSION,
    iat: now,
    exp,
    nonce,
    callSid,
  };

  const payloadEncoded = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = toBase64Url(
    crypto.createHmac('sha256', config.streamAuthSecret).update(payloadEncoded).digest()
  );
  return `${payloadEncoded}.${signature}`;
}

/**
 * @param {string} token
 * @returns {import('./types').StreamTokenVerificationResult}
 */
function verifyAndConsumeStreamToken(token) {
  pruneExpiredNonces();
  if (!token) return { ok: false, reason: 'missing token' };

  const pieces = token.split('.');
  if (pieces.length !== 2) return { ok: false, reason: 'invalid token format' };
  const [payloadEncoded, providedSig] = pieces;
  const expectedSig = toBase64Url(
    crypto.createHmac('sha256', config.streamAuthSecret).update(payloadEncoded).digest()
  );
  if (!safeEqualString(providedSig, expectedSig)) {
    return { ok: false, reason: 'invalid token signature' };
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(payloadEncoded).toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid token payload' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    payload.v !== STREAM_TOKEN_VERSION ||
    !payload.nonce ||
    payload.exp <= now ||
    payload.iat > now + 30
  ) {
    return { ok: false, reason: 'expired or malformed token' };
  }

  const pending = pendingStreamNonces.get(payload.nonce);
  if (!pending) return { ok: false, reason: 'nonce not pending' };
  if (pending.exp !== payload.exp || pending.callSid !== payload.callSid) {
    pendingStreamNonces.delete(payload.nonce);
    return { ok: false, reason: 'nonce payload mismatch' };
  }

  pendingStreamNonces.delete(payload.nonce);
  return { ok: true, callSid: payload.callSid || null };
}

/**
 * URLs Twilio may have signed for the `/media` WebSocket handshake.
 *
 * Twilio signs the URL it was told to connect to, i.e. the `<Stream url>` that
 * buildConnectStreamTwiml emits. Two documented quirks make the exact string
 * ambiguous, and both break every call if guessed wrong:
 *
 *   - the signature is computed over the `wss://` scheme even though the
 *     request arrives as an ordinary HTTP upgrade (twilio-aspnet#162);
 *   - Twilio's own guidance is to try a trailing `/` when validation fails.
 *
 * Each candidate is a distinct string that still has to HMAC to the presented
 * signature under the auth token, so trying all four grants an attacker
 * nothing: forging any one of them already requires the token.
 *
 * @param {string} [tunnelHostname]
 * @returns {string[]}
 */
function streamHandshakeSignedUrls(tunnelHostname = config.tunnelHostname) {
  return [
    `wss://${tunnelHostname}${STREAM_PATH}`,
    `wss://${tunnelHostname}${STREAM_PATH}/`,
    `https://${tunnelHostname}${STREAM_PATH}`,
    `https://${tunnelHostname}${STREAM_PATH}/`,
  ];
}

/**
 * Verify the `X-Twilio-Signature` on the `/media` WebSocket handshake.
 *
 * This is defence in depth, not a replacement for the one-time stream token.
 * The handshake carries no body and no query string, so the signature is an
 * HMAC over a constant URL and is identical on every call for the life of the
 * auth token. It rejects scanners and anything that has never observed a
 * genuine handshake; it does not resist replay by anything that has. Only
 * verifyAndConsumeStreamToken is single-use.
 *
 * @param {unknown} signature value of the (lowercase) x-twilio-signature header
 * @param {string} [tunnelHostname]
 * @returns {import('./types').StreamHandshakeVerificationResult}
 */
function verifyStreamHandshakeSignature(signature, tunnelHostname = config.tunnelHostname) {
  if (typeof signature !== 'string' || !signature) {
    return { ok: false, reason: 'missing handshake signature' };
  }
  for (const signedUrl of streamHandshakeSignedUrls(tunnelHostname)) {
    if (twilio.validateRequest(config.twilioAuthToken, signature, signedUrl, {})) {
      return { ok: true, signedUrl };
    }
  }
  return { ok: false, reason: 'invalid handshake signature' };
}

/**
 * @param {string | null} callSid
 * @param {string} [tunnelHostname]
 * @returns {string}
 */
function buildConnectStreamTwiml(callSid, tunnelHostname = config.tunnelHostname) {
  return `<Connect><Stream url="wss://${tunnelHostname}${STREAM_PATH}"><Parameter name="${STREAM_TOKEN_PARAMETER_NAME}" value="${escapeXmlAttribute(issueStreamToken(callSid))}"/></Stream></Connect>`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeXmlAttribute(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = {
  buildConnectStreamTwiml,
  issueStreamToken,
  STREAM_PATH,
  STREAM_TOKEN_PARAMETER_NAME,
  streamHandshakeSignedUrls,
  verifyAndConsumeStreamToken,
  verifyStreamHandshakeSignature,
};
