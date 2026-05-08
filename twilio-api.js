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
 * Terminate the call immediately.
 * Called when the HomeKit session is dismissed by the user.
 */
async function hangUpCall(callSid) {
  logger.info('Hanging up call', { event: 'hangup', callSid });
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

module.exports = { hangUpCall };
