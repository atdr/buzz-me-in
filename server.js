// based on https://github.com/twilio/media-streams/blob/master/node/basic/README.md
'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { PassThrough } = require('stream');
const HttpDispatcher  = require('httpdispatcher');
const WebSocketServer = require('websocket').server;

const state   = require('./state');
const homekit = require('./homekit');

const HTTP_SERVER_PORT = parseInt(process.env.PORT, 10) || 8080;

const dispatcher = new HttpDispatcher();
const wsserver   = http.createServer(handleRequest);

const mediaws = new WebSocketServer({
  httpServer: wsserver,
  autoAcceptConnections: true,
});

function log(message, ...args) {
  console.log(new Date().toISOString(), message, ...args);
}

function handleRequest(request, response) {
  try {
    dispatcher.dispatch(request, response);
  } catch (err) {
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

/**
 * POST /twiml
 * Twilio calls this when the intercom dials our number.
 * Returns TwiML that starts a bidirectional media stream and holds the call
 * open for up to an hour.
 *
 * <Pause length="3600"/> keeps the call alive without a <Redirect> loop.
 * A loop would cause Twilio to re-open the WebSocket on each iteration,
 * adding reconnection complexity. We manage the call lifecycle entirely via
 * the REST API instead (see twilio-api.js).
 */
dispatcher.onPost('/twiml', function(req, res) {
  log('POST /twiml');
  const filePath = path.join(__dirname, 'templates', 'streams.xml');
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'text/xml',
    'Content-Length': stat.size,
  });
  fs.createReadStream(filePath).pipe(res);
});

/**
 * GET /status — quick health/debug endpoint
 * Returns the current active call info (callSid only, no credentials).
 */
dispatcher.onGet('/status', function(_req, res) {
  const body = JSON.stringify(
    state.activeCall
      ? { active: true,  callSid: state.activeCall.callSid }
      : { active: false }
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
});

// ---------------------------------------------------------------------------
// WebSocket media stream
// ---------------------------------------------------------------------------

mediaws.on('connect', function(connection) {
  log('Media WS: connection accepted');
  new MediaStream(connection);
});

class MediaStream {
  constructor(connection) {
    this.connection   = connection;
    this.messageCount = 0;

    // Raw mulaw bytes from Twilio flow into this PassThrough.
    // homekit.js pipes it into the inbound ffmpeg when a HAP session opens.
    // highWaterMark: 32768 ≈ 4 s of mulaw/8kHz — enough buffer for the user
    // to see the doorbell notification and tap "View" in the Home app.
    this.mulawStream = new PassThrough({ highWaterMark: 32768 });

    connection.on('message', this.processMessage.bind(this));
    connection.on('close',   this.close.bind(this));
  }

  processMessage(message) {
    if (message.type !== 'utf8') return;

    const data = JSON.parse(message.utf8Data);

    switch (data.event) {

      case 'connected':
        log('Media WS: connected', data);
        break;

      case 'start':
        log('Media WS: start', data.start);
        // callSid and streamSid only appear in the 'start' event.
        state.activeCall = {
          callSid:      data.start.callSid,
          streamSid:    data.start.streamSid,
          wsConnection: this.connection,
        };
        homekit.setMulawPassthrough(this.mulawStream);
        homekit.triggerDoorbell();
        break;

      case 'media':
        // base64-decode the mulaw payload and push it into the PassThrough.
        // homekit.js has already piped this stream to ffmpeg's stdin.
        this.mulawStream.write(Buffer.from(data.media.payload, 'base64'));
        break;

      case 'stop':
        log('Media WS: stop', data);
        // Caller hung up — signal HomeKit and clean up.
        // Do NOT call hangUpCall here: the call is already gone.
        this.mulawStream.end();
        homekit.endHapSession();
        state.activeCall = null;
        break;
    }

    this.messageCount++;
  }

  close() {
    log('Media WS: closed after', this.messageCount, 'messages');
    // Guard: close() can fire without a prior 'stop' event (e.g. network drop).
    this.mulawStream.destroy();
    if (state.activeCall) {
      homekit.endHapSession();
      state.activeCall = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

wsserver.listen(HTTP_SERVER_PORT, () => {
  log(`Server listening on port ${HTTP_SERVER_PORT}`);
});
