'use strict';

/**
 * Twilio REST API helpers.
 * All functions accept a callSid string and return a Promise.
 *
 * Required environment variables:
 *   TWILIO_ACCOUNT_SID   – e.g. ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *   TWILIO_AUTH_TOKEN    – from Twilio Console
 *   TWILIO_PHONE_NUMBER  – the Twilio number that receives the intercom call
 *                          (only needed if you ever want to initiate outbound calls)
 */

const twilio = require('twilio');
const config = require('./src/core/config');
const { buildConnectStreamTwiml: buildStreamTwiml } = require('./src/core/stream-auth');
const { createLogger } = require('./src/core/log');

const logger = createLogger({ component: 'twilio-api' });
let _client = null;
function client() {
  if (!_client) {
    _client = twilio(config.twilioAccountSid, config.twilioAuthToken);
  }
  return _client;
}

/**
 * Send DTMF mid-call to open the intercom door.
 * The TwiML returns to <Connect><Stream> after the digit sequence so two-way audio resumes.
 */
async function unlockDoor(callSid) {
  const twiml = `<Response><Play digits="${escapeXmlAttribute(config.twilioUnlockDigits)}"/>${buildConnectStreamTwiml(callSid)}</Response>`;
  logger.info('Sending Twilio DTMF unlock', {
    event: 'unlock-dtmf-update',
    callSid,
    digits: config.twilioUnlockDigits,
  });
  const call = await client().calls(callSid).update({
    twiml,
  });
  logger.info('Twilio DTMF unlock update accepted', {
    event: 'unlock-dtmf-update-accepted',
    callSid,
    status: call && call.status,
  });
  return call;
}

/**
 * Terminate the call immediately.
 * Called when the HomeKit session is dismissed by the user.
 */
async function hangUpCall(callSid) {
  console.log(`[Twilio] Hanging up ${callSid}`);
  try {
    return await client().calls(callSid).update({
      twiml: `<Response><Hangup/></Response>`,
    });
  } catch (error) {
    if (isCallAlreadyEndedError(error)) {
      return { alreadyEnded: true, callSid };
    }
    throw error;
  }
}

function isCallAlreadyEndedError(error) {
  return (
    error && typeof error.message === 'string' && error.message.includes('Call is not in-progress')
  );
}

function buildConnectStreamTwiml(callSid) {
  return buildStreamTwiml(callSid, config.tunnelHostname);
}

function getUnlockDigits() {
  return config.twilioUnlockDigits;
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

module.exports = { getUnlockDigits, hangUpCall, unlockDoor };
