// based on https://github.com/twilio/media-streams/blob/master/node/basic/README.md
'use strict';

const http = require('http');
const twilio = require('twilio');
const { PassThrough } = require('stream');
const WebSocketServer = require('websocket').server;
const { parseTwilioWsEvent, parseTwilioMediaPayload } = require('./src/core/ws-events-schema');

const config = require('./src/core/config');
const state = require('./src/core/state');
const {
  createRingbackMulawCycle,
  createRingbackWav,
  sendMulawAudio,
} = require('./src/core/mulaw-audio');
const {
  buildConnectStreamTwiml,
  STREAM_TOKEN_PARAMETER_NAME,
  verifyAndConsumeStreamToken,
} = require('./src/core/stream-auth');
const homekit = require('./homekit');
const { createLogger } = require('./src/core/log');
const { safeEqualString } = require('./src/core/safe-equal');
/** @import { connection, request as WebSocketRequest, Message } from 'websocket' */
/** @import { WsEventParseResult, WsEventParseOkSupported, StartCallResult, MediaPayloadParseResult, StreamTokenVerificationResult, TokenVerificationError, WsEventParseError, MediaPayloadParseError } from './src/core/types' */

const HTTP_SERVER_PORT = config.port;
const STREAM_PATH = '/media';
const STREAM_START_TIMEOUT_MS = 5000;
const STATUS_BEARER_PREFIX = 'Bearer ';
const MAX_WS_UTF8_BYTES = config.wsMaxMessageBytes;
const SHUTDOWN_GRACE_MS = config.shutdownGraceMs;
let shuttingDown = false;
const activeWsConnections = new Set();
const logger = createLogger({ component: 'server' });
const mediaWsLogger = logger.child({ component: 'media-ws' });
const twimlLogger = logger.child({ component: 'twiml' });
const activeMediaStreamsByCallSid = new Map();

homekit.setOnHapSessionStarted((callSid) => {
  const mediaStream = activeMediaStreamsByCallSid.get(callSid);
  if (mediaStream) mediaStream.markHomekitSessionStarted();
});

// ---------------------------------------------------------------------------
// Ringtone — one UK-style ringback cycle (400Hz+450Hz dual tone), generated
// in-process as a WAV buffer. Served at GET /ringtone for debug/manual
// checks. Runtime ringback is sent over the bidirectional media stream so
// Twilio keeps the same WebSocket connected.
// ---------------------------------------------------------------------------
const RINGTONE_WAV = createRingbackWav();

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
    const handler = request.method === 'GET' ? GET_ROUTES.get(path) : undefined;
    if (handler) {
      handler(request, response);
      return;
    }
    response.writeHead(404);
    response.end('Not Found');
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

function buildTwiml(callSid) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${buildConnectStreamTwiml(callSid)}
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
  const callSid = typeof formData.CallSid === 'string' ? formData.CallSid : null;
  const body = buildTwiml(callSid);
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

/** @type {Map<string, (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void>} */
const GET_ROUTES = new Map();

/**
 * GET /ringtone
 * UK-style ring tone WAV for debug/manual checks.
 */
GET_ROUTES.set('/ringtone', function (_req, res) {
  res.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Content-Length': RINGTONE_WAV.length,
    'Cache-Control': 'no-store',
  });
  res.end(RINGTONE_WAV);
});

/**
 * GET /status — quick health/debug endpoint
 * Returns the current active call info (callSid only, no credentials).
 */
GET_ROUTES.set('/status', function (req, res) {
  if (!isAuthorizedForStatus(req)) {
    res.writeHead(401);
    res.end('Unauthorized');
    return;
  }
  const body = JSON.stringify(state.getStatus());
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
});

GET_ROUTES.set('/healthz', function (_req, res) {
  const body = JSON.stringify({ ok: true });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
});

GET_ROUTES.set('/readyz', function (_req, res) {
  const body = JSON.stringify({ ok: true });
  res.writeHead(200, { 'Content-Type': 'application/json' });
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
    this.hasHomekitSession = false;
    this.droppingFrames = false;
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

    // Raw mulaw bytes from Twilio flow into this PassThrough only after
    // HomeKit opens a live view. Pre-live buffering creates catch-up latency.
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
        if (started.ok === false) {
          mediaWsLogger.warn('Media websocket start rejected', {
            callSid: start.callSid,
            event: 'start',
            reason: started.reason,
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
        const reboundSessionCount = homekit.setMulawPassthrough(this.mulawStream);
        if (reboundSessionCount > 0) {
          this.markHomekitSessionStarted();
        } else {
          homekit.triggerDoorbell();
          this.startRingback();
        }
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
        if (this.hasHomekitSession) {
          // Only forward live-view audio. Buffering pre-answer audio adds seconds
          // of catch-up latency when HomeKit finally starts ffmpeg.
          // Drop frames while the buffer needs draining: for live audio,
          // unbounded queueing behind a stalled ffmpeg is worse than a gap.
          if (this.mulawStream.writableNeedDrain) {
            if (!this.droppingFrames) {
              this.droppingFrames = true;
              mediaWsLogger.warn('Dropping media frames; mulaw buffer is full', {
                callSid: this.currentCallSid,
                event: 'media-frames-dropped',
                reason: 'mulaw-buffer-full',
              });
            }
          } else {
            if (this.droppingFrames) {
              this.droppingFrames = false;
              mediaWsLogger.info('Resumed forwarding media frames', {
                callSid: this.currentCallSid,
                event: 'media-frames-resumed',
              });
            }
            this.mulawStream.write(mediaPayload.decoded);
          }
        }
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

  markHomekitSessionStarted() {
    this.hasHomekitSession = true;
    this.stopRingback('homekit-session-started');
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
    homekit.clearMulawPassthrough(this.mulawStream);
    this.mulawStream.destroy();
    const { cleared } = state.clearIfConnection(this.connection, reason);
    if (this.currentCallSid && activeMediaStreamsByCallSid.get(this.currentCallSid) === this) {
      activeMediaStreamsByCallSid.delete(this.currentCallSid);
    }
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

  state.clearActiveCall('server-shutdown');
  homekit.shutdown();

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

// Exit on unexpected errors instead of continuing in an undefined state;
// systemd restarts the service.
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception; exiting', {
    event: 'uncaught-exception',
    reason: 'uncaught-exception',
    error: err,
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection; exiting', {
    event: 'unhandled-rejection',
    reason: 'unhandled-rejection',
    error: reason instanceof Error ? reason : new Error(String(reason)),
  });
  process.exit(1);
});
