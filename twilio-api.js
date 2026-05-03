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

let _client = null;
function client() {
  if (!_client) {
    _client = twilio(config.twilioAccountSid, config.twilioAuthToken);
  }
  return _client;
}

/**
 * Send DTMF digit "9" mid-call to open the intercom door.
 * The TwiML includes a follow-up <Pause> so the call stays alive
 * and the media stream continues after the tone is sent.
 */
async function unlockDoor(callSid) {
  console.log(`[Twilio] Sending DTMF unlock to ${callSid}`);
  return client()
    .calls(callSid)
    .update({
      twiml: `<Response><Play digits="9"/>${buildConnectStreamTwiml(callSid)}</Response>`,
    });
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

module.exports = { hangUpCall, unlockDoor };
