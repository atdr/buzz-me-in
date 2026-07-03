'use strict';

/**
 * Twilio identifier formats and normalization.
 *
 * Dependency-free on purpose: this module is imported by both the token layer
 * (stream-auth.js) and the pure protocol schema (ws-events-schema.js), and the
 * latter must not transitively pull in config.js (which validates env at load).
 */

const CALL_SID_REGEX = /^CA[0-9a-f]{32}$/;

/**
 * Normalize an untrusted CallSid value (e.g. from webhook form data or the
 * Twilio WebSocket start event). Twilio always sends CallSid as "CA" + 32
 * lowercase hex chars; anything else (wrong shape, duplicate form keys parsed
 * as arrays, non-strings) is treated as absent so it never reaches logs,
 * tokens, or REST URLs.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeCallSid(value) {
  return typeof value === 'string' && CALL_SID_REGEX.test(value) ? value : null;
}

module.exports = { CALL_SID_REGEX, normalizeCallSid };
