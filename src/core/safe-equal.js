'use strict';

const crypto = require('crypto');

/**
 * Constant-time string comparison. Inputs are padded to a common length so
 * unequal lengths do not short-circuit the comparison.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqualString(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  const len = Math.max(left.length, right.length);
  const paddedLeft = Buffer.concat([left, Buffer.alloc(len - left.length)]);
  const paddedRight = Buffer.concat([right, Buffer.alloc(len - right.length)]);
  return crypto.timingSafeEqual(paddedLeft, paddedRight);
}

module.exports = { safeEqualString };
