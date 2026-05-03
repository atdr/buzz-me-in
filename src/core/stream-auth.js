'use strict';

const crypto = require('crypto');
const config = require('./config');

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

function safeEqualString(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  const len = Math.max(left.length, right.length);
  const paddedLeft = Buffer.concat([left, Buffer.alloc(len - left.length)]);
  const paddedRight = Buffer.concat([right, Buffer.alloc(len - right.length)]);
  return crypto.timingSafeEqual(paddedLeft, paddedRight);
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
  STREAM_TOKEN_PARAMETER_NAME,
  verifyAndConsumeStreamToken,
};
