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
const config = require('./config');

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
  return client().calls(callSid).update({
    twiml: `<Response><Play digits="9"/><Pause length="300"/></Response>`,
  });
}

/**
 * Stop ringing and hold the call open silently.
 * Called when HomeKit opens the camera live view (handleStreamRequest START).
 * Replaces the looping <Play> with a plain <Pause> so the media stream
 * continues without interruption.
 */
async function answerCall(callSid) {
  console.log(`[Twilio] Answering (stopping ringtone) for ${callSid}`);
  return client().calls(callSid).update({
    twiml: `<Response><Pause length="300"/></Response>`,
  });
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

module.exports = { answerCall, unlockDoor, hangUpCall };
