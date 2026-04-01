// based on https://github.com/twilio/media-streams/blob/master/node/basic/README.md
'use strict';

const fs = require('fs');
const http = require('http');
const twilio = require('twilio');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');
const HttpDispatcher = require('httpdispatcher');
const WebSocketServer = require('websocket').server;

const config = require('./config');
const state = require('./state');
const homekit = require('./homekit');

const HTTP_SERVER_PORT = config.port;
const STREAM_PATH = '/media';
const STREAM_TOKEN_VERSION = 1;
const STATUS_BEARER_PREFIX = 'Bearer ';
const pendingStreamNonces = new Map();
const MAX_WS_UTF8_BYTES = config.wsMaxMessageBytes;
const MAX_TWILIO_MEDIA_PAYLOAD_BYTES = config.twilioMediaPayloadMaxBytes;
const SHUTDOWN_GRACE_MS = config.shutdownGraceMs;
const BASE64_PAYLOAD_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
let ringtoneReady = false;
let shuttingDown = false;
const activeWsConnections = new Set();

// ---------------------------------------------------------------------------
// Ringtone — generated once at startup by ffmpeg.
// UK-style ring: 400Hz+450Hz dual tone, 0.4 s on / 2.6 s off in a 3 s loop.
// Served at GET /ringtone.wav; referenced by <Play loop="0"> in TwiML so
// Twilio loops it to the caller until HomeKit answers (answerCall REST update).
// ---------------------------------------------------------------------------
const RINGTONE_PATH = '/tmp/intercom_ringtone.wav';

function generateRingtone() {
  return new Promise((resolve) => {
    // Generate a 3-second UK-style double ring tone:
    //   400ms on, 200ms off, 400ms on, 2000ms off  (= 3 s, looped by Twilio)
    // Each burst is a 400Hz + 450Hz dual tone mixed at half amplitude.
    const ff = spawn('ffmpeg', [
      '-y',
      '-loglevel',
      'warning',
      // Burst 1: 400ms
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=400:duration=0.4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=450:duration=0.4',
      // Burst 2: 400ms
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=400:duration=0.4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=450:duration=0.4',
      // Silence source
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=8000:cl=mono',
      '-filter_complex',
      [
        // Mix each burst pair
        '[0][1]amix=inputs=2:duration=shortest,volume=0.5[b1]',
        '[2][3]amix=inputs=2:duration=shortest,volume=0.5[b2]',
        // 200ms silence between bursts, 2000ms silence after
        '[4]atrim=duration=0.2[gap]',
        '[4]atrim=duration=2.0[tail]',
        // Concatenate: burst1, gap, burst2, tail
        '[b1][gap][b2][tail]concat=n=4:v=0:a=1[out]',
      ].join(';'),
      '-map',
      '[out]',
      '-ar',
      '8000',
      '-ac',
      '1',
      RINGTONE_PATH,
    ]);
    ff.on('close', (code) => {
      if (code === 0) {
        log('Ringtone generated at', RINGTONE_PATH);
        ringtoneReady = true;
      } else {
        console.error('ffmpeg ringtone generation failed with code', code);
      }
      resolve();
    });
    ff.stderr.on('data', (d) => process.stderr.write('[ringtone ffmpeg] ' + d));
  });
}

generateRingtone();

const dispatcher = new HttpDispatcher();
const wsserver = http.createServer(handleRequest);

const mediaws = new WebSocketServer({
  httpServer: wsserver,
  autoAcceptConnections: false,
});

state.setOnSessionStale((session) => {
  log('Call session stale; ending session', session.callSid);
  if (session.wsConnection && typeof session.wsConnection.close === 'function') {
    try {
      session.wsConnection.close();
    } catch (err) {
      log('Failed to close stale call WebSocket:', err && err.message ? err.message : err);
    }
  }
  homekit.endHapSession();
});

function log(message, ...args) {
  console.log(new Date().toISOString(), message, ...args);
}

function handleRequest(request, response) {
  try {
    if (shuttingDown) {
      response.writeHead(503);
      response.end('Server shutting down');
      return;
    }
    const path = request.url ? request.url.split('?')[0] : '';
    if (request.method === 'POST' && path === '/twiml') {
      handleTwimlRequest(request, response).catch((err) => {
        console.error(err);
        if (!response.headersSent) response.writeHead(500);
        response.end('Internal Server Error');
      });
      return;
    }
    dispatcher.dispatch(request, response);
  } catch (err) {
    console.error(err);
    if (!response.headersSent) response.writeHead(500);
    response.end('Internal Server Error');
  }
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

function buildTwiml(streamToken) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://${config.tunnelHostname}${STREAM_PATH}?token=${encodeURIComponent(streamToken)}"/>
  </Start>
  <Play loop="0">https://${config.tunnelHostname}/ringtone</Play>
</Response>`;
}

async function handleTwimlRequest(req, res) {
  log('POST /twiml');

  // eslint-disable-next-line no-useless-assignment -- assigned before first use inside try for readable error path
  let rawBody = '';
  try {
    rawBody = await readRequestBody(req, 32 * 1024);
  } catch (err) {
    log('POST /twiml body read failed:', err.message);
    res.writeHead(400);
    res.end('Invalid request body');
    return;
  }

  if (!isValidTwilioRequest(req, rawBody)) {
    log('POST /twiml rejected: invalid Twilio signature');
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const formData = parseFormUrlEncoded(rawBody);
  const streamToken = issueStreamToken(
    typeof formData.CallSid === 'string' ? formData.CallSid : null
  );
  const body = buildTwiml(streamToken);
  res.writeHead(200, {
    'Content-Type': 'text/xml',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * GET /ringtone.wav
 * UK-style ring tone served to Twilio via <Play loop="0">.
 */
dispatcher.onGet('/ringtone', function (_req, res) {
  fs.readFile(RINGTONE_PATH, (err, data) => {
    if (err) {
      res.writeHead(503);
      res.end('Ringtone not ready');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

/**
 * GET /status — quick health/debug endpoint
 * Returns the current active call info (callSid only, no credentials).
 */
dispatcher.onGet('/status', function (_req, res) {
  if (!isAuthorizedForStatus(_req)) {
    res.writeHead(401);
    res.end('Unauthorized');
    return;
  }
  const body = JSON.stringify(state.getStatus());
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
});

dispatcher.onGet('/healthz', function (_req, res) {
  const body = JSON.stringify({ ok: true });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
});

dispatcher.onGet('/readyz', function (_req, res) {
  const body = JSON.stringify({
    ok: ringtoneReady,
    checks: { ringtoneGenerated: ringtoneReady },
  });
  res.writeHead(ringtoneReady ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(body);
});

// ---------------------------------------------------------------------------
// WebSocket media stream
// ---------------------------------------------------------------------------

mediaws.on('request', function (request) {
  if (shuttingDown) {
    request.reject(503, 'Server shutting down');
    return;
  }
  const path = request.resourceURL && request.resourceURL.pathname;
  if (path !== STREAM_PATH) {
    request.reject(404, 'Not found');
    return;
  }

  const query = request.resourceURL && request.resourceURL.query ? request.resourceURL.query : {};
  const token = typeof query.token === 'string' ? query.token : '';
  const verification = verifyAndConsumeStreamToken(token);
  if (!verification.ok) {
    log('Media WS: rejected -', verification.reason);
    request.reject(403, 'Unauthorized');
    return;
  }

  const connection = request.accept(null, request.origin);
  activeWsConnections.add(connection);
  connection.on('close', () => activeWsConnections.delete(connection));
  log('Media WS: connection accepted');
  new MediaStream(connection, verification.callSid);
});

class MediaStream {
  constructor(connection, expectedCallSid) {
    this.connection = connection;
    this.messageCount = 0;
    this.expectedCallSid = expectedCallSid;
    this.currentCallSid = null;
    this.started = false;
    this.closed = false;

    // Raw mulaw bytes from Twilio flow into this PassThrough.
    // homekit.js pipes it into the inbound ffmpeg when a HAP session opens.
    // highWaterMark: 32768 ≈ 4 s of mulaw/8kHz — enough buffer for the user
    // to see the doorbell notification and tap "View" in the Home app.
    this.mulawStream = new PassThrough({ highWaterMark: 32768 });

    connection.on('message', this.processMessage.bind(this));
    connection.on('close', this.close.bind(this));
  }

  processMessage(message) {
    if (message.type !== 'utf8') return;
    if (message.utf8Data.length > MAX_WS_UTF8_BYTES) {
      log('Media WS: message too large, closing connection');
      this.connection.close();
      return;
    }

    let data;
    try {
      data = JSON.parse(message.utf8Data);
    } catch {
      log('Media WS: invalid JSON message');
      this.connection.close();
      return;
    }

    const event = data && typeof data.event === 'string' ? data.event : null;
    if (!event) {
      log('Media WS: missing event field');
      this.connection.close();
      return;
    }

    switch (event) {
      case 'connected': {
        log('Media WS: connected', data);
        break;
      }

      case 'start': {
        if (this.started) {
          log('Media WS: duplicate start event');
          this.connection.close();
          return;
        }
        if (
          !data.start ||
          typeof data.start.callSid !== 'string' ||
          typeof data.start.streamSid !== 'string'
        ) {
          log('Media WS: invalid start payload');
          this.connection.close();
          return;
        }
        if (this.expectedCallSid && this.expectedCallSid !== data.start.callSid) {
          log('Media WS: start rejected due to callSid mismatch');
          this.connection.close();
          return;
        }
        const started = state.startCall({
          callSid: data.start.callSid,
          streamSid: data.start.streamSid,
          wsConnection: this.connection,
        });
        if (!started.ok) {
          log('Media WS: rejecting start -', started.reason);
          this.connection.close();
          return;
        }
        log('Media WS: start', data.start);
        this.currentCallSid = data.start.callSid;
        this.started = true;
        homekit.setMulawPassthrough(this.mulawStream);
        homekit.triggerDoorbell();
        break;
      }

      case 'media': {
        if (!this.started || !this.currentCallSid) {
          log('Media WS: media received before start');
          this.connection.close();
          return;
        }
        if (!data.media || typeof data.media.payload !== 'string') {
          break;
        }
        const payload = data.media.payload;
        if (payload.length % 4 !== 0 || !BASE64_PAYLOAD_REGEX.test(payload)) {
          log('Media WS: invalid media payload encoding');
          this.connection.close();
          return;
        }
        const decoded = Buffer.from(payload, 'base64');
        if (decoded.length > MAX_TWILIO_MEDIA_PAYLOAD_BYTES) {
          log('Media WS: media payload too large');
          this.connection.close();
          return;
        }
        // base64-decode the mulaw payload and push it into the PassThrough.
        // homekit.js has already piped this stream to ffmpeg's stdin.
        this.mulawStream.write(decoded);
        state.markActivity(this.currentCallSid, 'twilio-media');
        break;
      }

      case 'stop': {
        log('Media WS: stop', data);
        this._teardown('twilio-stop');
        break;
      }

      default: {
        log('Media WS: unknown event type', event);
        break;
      }
    }

    this.messageCount++;
  }

  close() {
    this._teardown('ws-close');
  }

  _teardown(reason) {
    if (this.closed) return;
    this.closed = true;
    log('Media WS: session ended', { reason, messages: this.messageCount });
    // Guard: close() can fire without a prior 'stop' event (e.g. network drop).
    this.mulawStream.destroy();
    const { cleared } = state.clearIfConnection(this.connection, reason);
    if (cleared) {
      homekit.endHapSession();
    }
  }
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseFormUrlEncoded(body) {
  const parsed = {};
  const params = new URLSearchParams(body);
  for (const [key, value] of params) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      const existing = parsed[key];
      parsed[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      parsed[key] = value;
    }
  }
  return parsed;
}

function isValidTwilioRequest(req, rawBody) {
  const signature = req.headers['x-twilio-signature'];
  if (typeof signature !== 'string' || !signature) return false;

  const url = new URL(req.url || '/twiml', config.twilioWebhookBaseUrl);
  const requestUrl = `${config.twilioWebhookBaseUrl}${url.pathname}${url.search}`;
  const params = parseFormUrlEncoded(rawBody);

  return twilio.validateRequest(config.twilioAuthToken, signature, requestUrl, params);
}

function toBase64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function safeEqualString(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  const len = Math.max(left.length, right.length);
  const paddedLeft = Buffer.concat([left, Buffer.alloc(len - left.length)]);
  const paddedRight = Buffer.concat([right, Buffer.alloc(len - right.length)]);
  return crypto.timingSafeEqual(paddedLeft, paddedRight);
}

function pruneExpiredNonces() {
  const now = Math.floor(Date.now() / 1000);
  for (const [nonce, data] of pendingStreamNonces.entries()) {
    if (data.exp <= now) pendingStreamNonces.delete(nonce);
  }
}

function issueStreamToken(callSid) {
  pruneExpiredNonces();

  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.streamAuthTtlSec;
  const nonce = crypto.randomBytes(16).toString('hex');

  pendingStreamNonces.set(nonce, { exp, callSid });

  const payload = {
    v: STREAM_TOKEN_VERSION,
    iat: now,
    exp,
    nonce,
    callSid,
  };

  const payloadEncoded = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = toBase64Url(
    crypto.createHmac('sha256', config.streamAuthSecret).update(payloadEncoded).digest()
  );
  return `${payloadEncoded}.${signature}`;
}

function verifyAndConsumeStreamToken(token) {
  pruneExpiredNonces();
  if (!token) return { ok: false, reason: 'missing token' };

  const pieces = token.split('.');
  if (pieces.length !== 2) return { ok: false, reason: 'invalid token format' };
  const [payloadEncoded, providedSig] = pieces;
  const expectedSig = toBase64Url(
    crypto.createHmac('sha256', config.streamAuthSecret).update(payloadEncoded).digest()
  );
  if (!safeEqualString(providedSig, expectedSig)) {
    return { ok: false, reason: 'invalid token signature' };
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(payloadEncoded).toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid token payload' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    payload.v !== STREAM_TOKEN_VERSION ||
    !payload.nonce ||
    payload.exp <= now ||
    payload.iat > now + 30
  ) {
    return { ok: false, reason: 'expired or malformed token' };
  }

  const pending = pendingStreamNonces.get(payload.nonce);
  if (!pending) return { ok: false, reason: 'nonce not pending' };
  if (pending.exp !== payload.exp || pending.callSid !== payload.callSid) {
    pendingStreamNonces.delete(payload.nonce);
    return { ok: false, reason: 'nonce payload mismatch' };
  }

  pendingStreamNonces.delete(payload.nonce);
  return { ok: true, callSid: payload.callSid || null };
}

function isAuthorizedForStatus(req) {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith(STATUS_BEARER_PREFIX)) {
    return false;
  }
  const provided = authHeader.slice(STATUS_BEARER_PREFIX.length);
  return safeEqualString(provided, config.statusApiToken);
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

wsserver.listen(HTTP_SERVER_PORT, () => {
  log(`Server listening on port ${HTTP_SERVER_PORT}`);
});

function beginShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received; starting graceful shutdown`);

  const forceExitTimer = setTimeout(() => {
    log('Shutdown grace period exceeded; forcing exit');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  if (typeof forceExitTimer.unref === 'function') forceExitTimer.unref();

  const { cleared } = state.clearActiveCall('server-shutdown');
  if (cleared) homekit.endHapSession();

  for (const connection of activeWsConnections) {
    try {
      connection.close();
    } catch {}
  }

  wsserver.close(() => {
    clearTimeout(forceExitTimer);
    state.stop();
    log('HTTP server closed; shutdown complete');
    process.exit(0);
  });
}

process.on('SIGINT', () => beginShutdown('SIGINT'));
process.on('SIGTERM', () => beginShutdown('SIGTERM'));
