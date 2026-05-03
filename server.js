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
const { parseTwilioWsEvent, parseTwilioMediaPayload } = require('./src/core/ws-events-schema');

const config = require('./src/core/config');
const state = require('./src/core/state');
const { createRingbackMulawCycle, sendMulawAudio } = require('./src/core/dtmf');
const homekit = require('./homekit');
const { createLogger } = require('./src/core/log');
/** @import { connection, request as WebSocketRequest, Message } from 'websocket' */
/** @import { WsEventParseResult, WsEventParseOkSupported, StartCallResult, MediaPayloadParseResult, StreamTokenVerificationResult, TokenVerificationError, WsEventParseError, MediaPayloadParseError } from './src/core/types' */

const HTTP_SERVER_PORT = config.port;
const STREAM_PATH = '/media';
const STREAM_TOKEN_PARAMETER_NAME = 'token';
const STREAM_TOKEN_VERSION = 1;
const STREAM_START_TIMEOUT_MS = 5000;
const STATUS_BEARER_PREFIX = 'Bearer ';
const pendingStreamNonces = new Map();
const MAX_WS_UTF8_BYTES = config.wsMaxMessageBytes;
const SHUTDOWN_GRACE_MS = config.shutdownGraceMs;
let ringtoneReady = false;
let shuttingDown = false;
const activeWsConnections = new Set();
const logger = createLogger({ component: 'server' });
const mediaWsLogger = logger.child({ component: 'media-ws' });
const twimlLogger = logger.child({ component: 'twiml' });
const activeMediaStreamsByCallSid = new Map();

homekit.setOnHapSessionStarted((callSid) => {
  const mediaStream = activeMediaStreamsByCallSid.get(callSid);
  if (mediaStream) mediaStream.stopRingback('homekit-session-started');
});

// ---------------------------------------------------------------------------
// Ringtone — generated once at startup by ffmpeg.
// UK-style ring: 400Hz+450Hz dual tone, 0.4 s on / 2.6 s off in a 3 s loop.
// Served at GET /ringtone for debug/manual checks. Runtime ringback is sent over
// the bidirectional media stream so Twilio keeps the same WebSocket connected.
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
        logger.info('Ringtone generated', {
          event: 'ringtone-generated',
          path: RINGTONE_PATH,
        });
        ringtoneReady = true;
      } else {
        logger.error('Ringtone generation failed', {
          event: 'ringtone-generation-failed',
          reason: 'ffmpeg-exit-nonzero',
          exitCode: code,
        });
      }
      resolve();
    });
    ff.stderr.on('data', (d) => {
      mediaWsLogger.warn('Ringtone ffmpeg stderr', {
        event: 'ringtone-ffmpeg-stderr',
        detail: d.toString('utf8').trim(),
      });
    });
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
  logger.warn('Call session stale; ending session', {
    callSid: session.callSid,
    event: 'session-stale',
    reason: session.clearedReason,
  });
  if (session.wsConnection && typeof session.wsConnection.close === 'function') {
    try {
      session.wsConnection.close();
    } catch (err) {
      logger.error('Failed to close stale call websocket', {
        callSid: session.callSid,
        event: 'stale-close-failed',
        reason: 'close-threw',
        error: err,
      });
    }
  }
  homekit.endHapSession();
});

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
        twimlLogger.error('Unhandled TwiML handler failure', {
          event: 'twiml-unhandled-error',
          reason: 'handler-threw',
          error: err,
        });
        if (!response.headersSent) response.writeHead(500);
        response.end('Internal Server Error');
      });
      return;
    }
    dispatcher.dispatch(request, response);
  } catch (err) {
    logger.error('HTTP request handling failed', {
      event: 'request-handler-error',
      reason: 'handler-threw',
      error: err,
    });
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
  <Connect>
    <Stream url="wss://${config.tunnelHostname}${STREAM_PATH}">
      <Parameter name="${STREAM_TOKEN_PARAMETER_NAME}" value="${escapeXmlAttribute(streamToken)}"/>
    </Stream>
  </Connect>
</Response>`;
}

async function handleTwimlRequest(req, res) {
  twimlLogger.info('Incoming TwiML request', {
    event: 'twiml-request',
    method: req.method,
    path: req.url ? req.url.split('?')[0] : '',
  });

  // eslint-disable-next-line no-useless-assignment -- assigned before first use inside try for readable error path
  let rawBody = '';
  try {
    rawBody = await readRequestBody(req, 32 * 1024);
  } catch (err) {
    twimlLogger.warn('TwiML body read failed', {
      event: 'twiml-body-read-failed',
      reason: 'invalid-request-body',
      error: err,
    });
    res.writeHead(400);
    res.end('Invalid request body');
    return;
  }

  if (!isValidTwilioRequest(req, rawBody)) {
    twimlLogger.warn('TwiML request rejected', {
      event: 'twiml-rejected',
      reason: 'invalid-twilio-signature',
    });
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const formData = parseFormUrlEncoded(rawBody);
  const streamToken = issueStreamToken(
    typeof formData.CallSid === 'string' ? formData.CallSid : null
  );
  const body = buildTwiml(streamToken);
  twimlLogger.info('TwiML response generated', {
    event: 'twiml-response',
    callSid: typeof formData.CallSid === 'string' ? formData.CallSid : undefined,
  });
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
  /** @type {WebSocketRequest} */
  const wsRequest = request;
  if (shuttingDown) {
    wsRequest.reject(503, 'Server shutting down');
    return;
  }
  const path = wsRequest.resourceURL && wsRequest.resourceURL.pathname;
  if (path !== STREAM_PATH) {
    wsRequest.reject(404, 'Not found');
    return;
  }

  const connection = wsRequest.accept(null, wsRequest.origin);
  activeWsConnections.add(connection);
  connection.on('close', () => activeWsConnections.delete(connection));
  mediaWsLogger.info('Media websocket connection accepted', {
    event: 'media-ws-accepted',
  });
  new MediaStream(connection);
});

class MediaStream {
  /**
   * @param {connection} connection
   */
  constructor(connection) {
    this.connection = connection;
    this.messageCount = 0;
    this.currentCallSid = null;
    this.started = false;
    this.closed = false;
    this.ringbackTimer = null;
    this.ringbackOffset = 0;
    this.ringbackPayload = createRingbackMulawCycle();
    this.startTimeout = setTimeout(() => {
      if (!this.started) {
        mediaWsLogger.warn('Media websocket start timed out', {
          event: 'start',
          reason: 'start-timeout',
        });
        this.connection.close();
      }
    }, STREAM_START_TIMEOUT_MS);
    this.startTimeout.unref();

    // Raw mulaw bytes from Twilio flow into this PassThrough.
    // homekit.js pipes it into the inbound ffmpeg when a HAP session opens.
    // highWaterMark: 32768 ≈ 4 s of mulaw/8kHz — enough buffer for the user
    // to see the doorbell notification and tap "View" in the Home app.
    this.mulawStream = new PassThrough({ highWaterMark: 32768 });

    connection.on('message', this.processMessage.bind(this));
    connection.on('close', this.close.bind(this));
  }

  /**
   * @param {Message} message
   */
  processMessage(message) {
    if (message.type !== 'utf8') return;
    if (message.utf8Data.length > MAX_WS_UTF8_BYTES) {
      mediaWsLogger.warn('Media websocket message too large', {
        event: 'media-ws-message-too-large',
        reason: 'max-message-bytes-exceeded',
      });
      this.connection.close();
      return;
    }

    let rawData;
    try {
      rawData = JSON.parse(message.utf8Data);
    } catch {
      mediaWsLogger.warn('Media websocket invalid JSON', {
        event: 'media-ws-invalid-json',
        reason: 'json-parse-failed',
      });
      this.connection.close();
      return;
    }

    const parsedResult = parseTwilioWsEvent(rawData);
    if (!parsedResult.ok) {
      const parsedError = /** @type {WsEventParseError} */ (parsedResult);
      mediaWsLogger.warn('Media websocket invalid event payload', {
        event: 'media-ws-invalid-event-payload',
        reason: parsedError.reason,
      });
      this.connection.close();
      return;
    }
    if (parsedResult.unsupported) {
      mediaWsLogger.info('Media websocket unsupported event ignored', {
        event: 'media-ws-unsupported-event',
        reason: parsedResult.event,
      });
      this.messageCount++;
      return;
    }
    const parsed = /** @type {WsEventParseOkSupported} */ (parsedResult);

    switch (parsed.event) {
      case 'connected': {
        mediaWsLogger.info('Media websocket connected event', {
          event: 'connected',
        });
        break;
      }

      case 'start': {
        if (this.started) {
          mediaWsLogger.warn('Duplicate media websocket start event', {
            event: 'start',
            reason: 'duplicate-start',
          });
          this.connection.close();
          return;
        }
        const start = parsed.data.start;
        const token = start.customParameters
          ? start.customParameters[STREAM_TOKEN_PARAMETER_NAME]
          : undefined;
        /** @type {StreamTokenVerificationResult} */
        const verification = verifyAndConsumeStreamToken(typeof token === 'string' ? token : '');
        if (!verification.ok) {
          const verificationError = /** @type {TokenVerificationError} */ (verification);
          mediaWsLogger.warn('Media websocket start rejected', {
            callSid: start.callSid,
            event: 'start',
            reason: verificationError.reason,
          });
          this.connection.close();
          return;
        }
        if (verification.callSid && verification.callSid !== start.callSid) {
          mediaWsLogger.warn('Media websocket start rejected', {
            callSid: start.callSid,
            event: 'start',
            reason: 'callsid-mismatch',
          });
          this.connection.close();
          return;
        }
        const started = state.startCall({
          callSid: start.callSid,
          streamSid: start.streamSid,
          wsConnection: this.connection,
        });
        if (!started.ok) {
          const startError = /** @type {{ ok: false, reason: string }} */ (started);
          mediaWsLogger.warn('Media websocket start rejected', {
            callSid: start.callSid,
            event: 'start',
            reason: startError.reason,
          });
          this.connection.close();
          return;
        }
        mediaWsLogger.info('Media websocket start accepted', {
          callSid: start.callSid,
          event: 'start',
          streamSid: start.streamSid,
        });
        clearTimeout(this.startTimeout);
        this.currentCallSid = start.callSid;
        this.started = true;
        activeMediaStreamsByCallSid.set(start.callSid, this);
        homekit.setMulawPassthrough(this.mulawStream);
        homekit.triggerDoorbell();
        this.startRingback();
        break;
      }

      case 'media': {
        if (!this.started || !this.currentCallSid) {
          mediaWsLogger.warn('Media frame before start event', {
            event: 'media',
            reason: 'media-before-start',
          });
          this.connection.close();
          return;
        }
        const mediaPayload = parseTwilioMediaPayload(
          parsed.data.media.payload,
          config.twilioMediaPayloadMaxBytes
        );
        if (!mediaPayload.ok) {
          const mediaPayloadError = /** @type {MediaPayloadParseError} */ (mediaPayload);
          mediaWsLogger.warn('Media payload rejected', {
            callSid: this.currentCallSid,
            event: 'media',
            reason: mediaPayloadError.reason,
          });
          this.connection.close();
          return;
        }
        // base64-decode the mulaw payload and push it into the PassThrough.
        // homekit.js has already piped this stream to ffmpeg's stdin.
        this.mulawStream.write(mediaPayload.decoded);
        state.markActivity(this.currentCallSid, 'twilio-media');
        break;
      }

      case 'stop': {
        mediaWsLogger.info('Media websocket stop event', {
          callSid: this.currentCallSid || undefined,
          event: 'stop',
        });
        this._teardown('twilio-stop');
        break;
      }
    }

    this.messageCount++;
  }

  close() {
    this._teardown('ws-close');
  }

  startRingback() {
    if (this.ringbackTimer || !this.currentCallSid) return;
    this.ringbackTimer = setInterval(() => {
      if (this.closed || !this.currentCallSid) {
        this.stopRingback('stream-ended');
        return;
      }
      this.sendRingbackFrame();
    }, 20);
    if (typeof this.ringbackTimer.unref === 'function') this.ringbackTimer.unref();
  }

  stopRingback(reason) {
    if (!this.ringbackTimer) return;
    clearInterval(this.ringbackTimer);
    this.ringbackTimer = null;
    mediaWsLogger.info('Ringback media stopped', {
      callSid: this.currentCallSid || undefined,
      event: 'ringback-stopped',
      reason,
    });
  }

  sendRingbackFrame() {
    if (!this.currentCallSid || !this.started || this.closed) return;

    const chunkSize = 160; // 20 ms of 8 kHz mu-law audio.
    const chunk = Buffer.alloc(chunkSize);
    for (let i = 0; i < chunkSize; i++) {
      chunk[i] = this.ringbackPayload[this.ringbackOffset];
      this.ringbackOffset = (this.ringbackOffset + 1) % this.ringbackPayload.length;
    }

    const activeCall = state.getActiveCall();
    if (!activeCall || activeCall.wsConnection !== this.connection || !activeCall.streamSid) return;
    sendMulawAudio(activeCall, chunk);
  }

  _teardown(reason) {
    if (this.closed) return;
    this.closed = true;
    this.stopRingback(reason);
    mediaWsLogger.info('Media websocket session ended', {
      callSid: this.currentCallSid || undefined,
      event: 'session-ended',
      reason,
      messageCount: this.messageCount,
    });
    clearTimeout(this.startTimeout);
    // Guard: close() can fire without a prior 'stop' event (e.g. network drop).
    this.mulawStream.destroy();
    const { cleared } = state.clearIfConnection(this.connection, reason);
    if (this.currentCallSid) activeMediaStreamsByCallSid.delete(this.currentCallSid);
    if (cleared) {
      homekit.endHapSession();
    }
  }
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
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

/**
 * @param {string} body
 * @returns {Record<string, string | string[]>}
 */
function parseFormUrlEncoded(body) {
  /** @type {Record<string, string | string[]>} */
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

/**
 * @param {import('http').IncomingMessage} req
 * @param {string} rawBody
 * @returns {boolean}
 */
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

function pruneExpiredNonces() {
  const now = Math.floor(Date.now() / 1000);
  for (const [nonce, data] of pendingStreamNonces.entries()) {
    if (data.exp <= now) pendingStreamNonces.delete(nonce);
  }
}

/**
 * @param {string | null} callSid
 * @returns {string}
 */
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

/**
 * @param {string} token
 * @returns {StreamTokenVerificationResult}
 */
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

/**
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
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
  logger.info('Server listening', {
    event: 'server-start',
    port: HTTP_SERVER_PORT,
  });
});

function beginShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const shutdownStartedAt = Date.now();
  logger.info('Graceful shutdown started', {
    event: 'shutdown-start',
    reason: signal,
  });

  const forceExitTimer = setTimeout(() => {
    logger.error('Shutdown grace period exceeded; forcing exit', {
      event: 'shutdown-force-exit',
      reason: 'grace-period-exceeded',
      durationMs: SHUTDOWN_GRACE_MS,
    });
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
    logger.info('Shutdown complete', {
      event: 'shutdown-complete',
      durationMs: Date.now() - shutdownStartedAt,
    });
    process.exit(0);
  });
}

process.on('SIGINT', () => beginShutdown('SIGINT'));
process.on('SIGTERM', () => beginShutdown('SIGTERM'));
