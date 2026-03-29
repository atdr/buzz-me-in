// based on https://github.com/twilio/media-streams/blob/master/node/basic/README.md
'use strict';

require('dotenv').config();

const fs   = require('fs');
const http = require('http');
const { PassThrough } = require('stream');
const { spawn }       = require('child_process');
const HttpDispatcher  = require('httpdispatcher');
const WebSocketServer = require('websocket').server;

const state   = require('./state');
const homekit = require('./homekit');

const HTTP_SERVER_PORT = parseInt(process.env.PORT, 10) || 8080;

// ---------------------------------------------------------------------------
// Ringtone — generated once at startup by ffmpeg.
// UK-style ring: 400Hz+450Hz dual tone, 0.4 s on / 2.6 s off in a 3 s loop.
// Served at GET /ringtone.wav; referenced by <Play loop="0"> in TwiML so
// Twilio loops it to the caller until HomeKit answers (answerCall REST update).
// ---------------------------------------------------------------------------
const RINGTONE_PATH = '/tmp/intercom_ringtone.wav';

function generateRingtone() {
  return new Promise((resolve) => {
    // Generate a 3-second UK-style ring tone:
    //   - Two sine waves (400 Hz + 450 Hz) mixed together for 0.4 s
    //   - Followed by 2.6 s of silence
    // Uses the sine lavfi source + amix + apad + atrim — widely supported
    // across ffmpeg versions without needing aevalsrc.
    const ff = spawn('ffmpeg', [
      '-y', '-loglevel', 'warning',
      '-f', 'lavfi', '-i', 'sine=frequency=400:duration=0.4',
      '-f', 'lavfi', '-i', 'sine=frequency=450:duration=0.4',
      '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono',
      '-filter_complex',
      '[0][1]amix=inputs=2:duration=shortest[tone];[tone][2]concat=n=2:v=0:a=1,apad=pad_dur=2.6,atrim=duration=3[out]',
      '-map', '[out]',
      '-ar', '8000', '-ac', '1',
      RINGTONE_PATH,
    ]);
    ff.on('close', code => {
      if (code === 0) {
        log('Ringtone generated at', RINGTONE_PATH);
      } else {
        console.error('ffmpeg ringtone generation failed with code', code);
      }
      resolve();
    });
    ff.stderr.on('data', d => process.stderr.write('[ringtone ffmpeg] ' + d));
  });
}

generateRingtone();

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
 * <Pause length="300"/> keeps the call alive without a <Redirect> loop.
 * A loop would cause Twilio to re-open the WebSocket on each iteration,
 * adding reconnection complexity. We manage the call lifecycle entirely via
 * the REST API instead (see twilio-api.js).
 */
dispatcher.onPost('/twiml', function(_req, res) {
  log('POST /twiml');
  const tunnelHost = process.env.TUNNEL_HOSTNAME;
  if (!tunnelHost) {
    log('ERROR: TUNNEL_HOSTNAME not set');
    res.writeHead(500);
    res.end('TUNNEL_HOSTNAME environment variable not set');
    return;
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://${tunnelHost}/"/>
  </Start>
  <Play loop="0">https://${tunnelHost}/ringtone.wav</Play>
</Response>`;
  res.writeHead(200, {
    'Content-Type': 'text/xml',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
});

/**
 * GET /ringtone.wav
 * UK-style ring tone served to Twilio via <Play loop="0">.
 */
dispatcher.onGet('/ringtone.wav', function(_req, res) {
  fs.readFile(RINGTONE_PATH, (err, data) => {
    if (err) {
      res.writeHead(503);
      res.end('Ringtone not ready');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': data.length });
    res.end(data);
  });
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
