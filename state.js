'use strict';

/**
 * Shared mutable call state.
 * Set when the Twilio WebSocket fires 'start'; cleared on 'stop' or WS close.
 *
 * @type {{ callSid: string, streamSid: string, wsConnection: object } | null}
 */
module.exports = {
  activeCall: null,
};
