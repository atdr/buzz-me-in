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
  console.log(`[Twilio] Hanging up ${callSid}`);
  return client().calls(callSid).update({
    twiml: `<Response><Hangup/></Response>`,
  });
}

module.exports = { hangUpCall };
