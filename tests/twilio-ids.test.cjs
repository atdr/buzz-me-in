const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCallSid, CALL_SID_REGEX } = require('../src/core/twilio-ids');

const HEX32 = '0123456789abcdef'.repeat(2);
const VALID_CALL_SID = `CA${HEX32}`;

test('normalizeCallSid', async (t) => {
  await t.test('accepts a canonical Twilio CallSid', () => {
    assert.equal(normalizeCallSid(VALID_CALL_SID), VALID_CALL_SID);
    assert.equal(CALL_SID_REGEX.test(VALID_CALL_SID), true);
  });

  await t.test('rejects malformed values as null', () => {
    assert.equal(normalizeCallSid(`CA${HEX32.toUpperCase()}`), null); // uppercase hex
    assert.equal(normalizeCallSid(`SM${HEX32}`), null); // wrong prefix
    assert.equal(normalizeCallSid(`CA${HEX32.slice(1)}`), null); // too short
    assert.equal(normalizeCallSid(`CA${HEX32}0`), null); // too long
    assert.equal(normalizeCallSid(''), null);
    assert.equal(normalizeCallSid(null), null);
    assert.equal(normalizeCallSid(undefined), null);
    assert.equal(normalizeCallSid([VALID_CALL_SID, VALID_CALL_SID]), null); // duplicate form keys
  });
});
