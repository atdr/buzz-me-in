#!/usr/bin/env node
// based on https://github.com/twilio/media-streams/blob/master/node/basic/README.md
'use strict';

// CLI flags are handled before every other require, and moving this down breaks
// them: requiring ./src/core/config throws on any missing env var, which under
// systemd lives in EnvironmentFile and so is absent from an interactive shell,
// and requiring ./homekit pulls in that same config. A read-only query must
// touch neither. tests/cli.test.cjs pins this ordering.
//
// The require.main guard keeps process.argv out of it when this file is loaded
// as a library rather than run: a test or the coverage run would otherwise have
// the test runner's own argv parsed as intercom flags. Everything below module
// scope is likewise inert until main() runs.
//
// Writes are synchronous because process.exit() can truncate a pending async
// write to a pipe.
if (require.main === module) {
  const cliFs = require('fs');
  const cliExit = require('./src/core/cli').run({
    argv: process.argv.slice(2),
    write: (text) => cliFs.writeSync(1, text),
    writeErr: (text) => cliFs.writeSync(2, text),
    isTTY: Boolean(process.stdout.isTTY),
    cwd: process.cwd(),
  });
  if (cliExit !== null) process.exit(cliExit);
}

const http = require('http');
const twilio = require('twilio');
const WebSocketServer = require('websocket').server;

const config = require('./src/core/config');
const state = require('./src/core/state');
const { createRingbackWav } = require('./src/core/mulaw-audio');
const {
  buildConnectStreamTwiml,
  STREAM_TOKEN_PARAMETER_NAME,
  verifyAndConsumeStreamToken,
  verifyStreamHandshakeSignature,
} = require('./src/core/stream-auth');
const { normalizeCallSid } = require('./src/core/twilio-ids');
const homekit = require('./homekit');
const { createLogger } = require('./src/core/log');
const { safeEqualString } = require('./src/core/safe-equal');
const { MediaStream } = require('./src/core/media-stream');
/** @import { request as WebSocketRequest } from 'websocket' */
/** @import { HandshakeVerificationError } from './src/core/types' */

const HTTP_SERVER_PORT = config.port;
const STREAM_PATH = '/media';
const STREAM_START_TIMEOUT_MS = config.streamStartTimeoutMs;
const STATUS_BEARER_PREFIX = 'Bearer ';
const MAX_WS_UTF8_BYTES = config.wsMaxMessageBytes;
const MEDIA_SIGNATURE_MODE = config.twilioMediaSignatureMode;
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

// Enforce message bounds in the websocket library itself so oversized
// frames are rejected before assembly, instead of relying only on the
// per-message check in MediaStream (library defaults allow 1 MiB).
const WS_LIBRARY_MAX_BYTES = MAX_WS_UTF8_BYTES * 4;
const MAX_CONCURRENT_WS_CONNECTIONS = config.wsMaxConnections;

const mediaws = new WebSocketServer({
  httpServer: wsserver,
  autoAcceptConnections: false,
  maxReceivedFrameSize: WS_LIBRARY_MAX_BYTES,
  maxReceivedMessageSize: WS_LIBRARY_MAX_BYTES,
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
  const callSid = normalizeCallSid(formData.CallSid);
  const body = buildTwiml(callSid);
  twimlLogger.info('TwiML response generated', {
    event: 'twiml-response',
    callSid: callSid || undefined,
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
  // Twilio signs the Media Streams handshake, so an unauthenticated socket can
  // be refused here rather than after accept(). Without this the server accepts
  // the connection and allocates a MediaStream before any auth runs, because
  // the stream token only arrives later in the `start` frame. Defence in depth:
  // the one-time token below remains the authority, since this signature is an
  // HMAC over a constant URL and so never varies between calls.
  if (MEDIA_SIGNATURE_MODE !== 'off') {
    const handshake = verifyStreamHandshakeSignature(
      wsRequest.httpRequest.headers['x-twilio-signature']
    );
    if (!handshake.ok) {
      // strict:false disables discriminated-union narrowing; cast as elsewhere.
      const handshakeError = /** @type {HandshakeVerificationError} */ (handshake);
      mediaWsLogger.warn('Media websocket handshake signature rejected', {
        event: 'media-ws-rejected',
        reason: handshakeError.reason,
        enforced: MEDIA_SIGNATURE_MODE === 'enforce',
      });
      if (MEDIA_SIGNATURE_MODE === 'enforce') {
        wsRequest.reject(403, 'Forbidden');
        return;
      }
    } else {
      mediaWsLogger.debug('Media websocket handshake signature verified', {
        event: 'media-ws-handshake-verified',
        signedUrl: handshake.signedUrl,
      });
    }
  }

  // Memory backstop only: cap total sockets so a connection flood can't grow
  // unbounded. Only one Twilio call is ever authenticated at a time, and each
  // un-started socket is dropped after config.streamStartTimeoutMs, so this is
  // deliberately generous. Volumetric / per-source rate-limiting is delegated
  // to the Cloudflare edge — the tunnel makes every socket look like localhost,
  // so in-process source accounting is both unreliable and trivially bypassed
  // by IP rotation.
  if (activeWsConnections.size >= MAX_CONCURRENT_WS_CONNECTIONS) {
    mediaWsLogger.warn('Media websocket connection rejected', {
      event: 'media-ws-rejected',
      reason: 'too-many-connections',
    });
    wsRequest.reject(503, 'Too many connections');
    return;
  }

  const connection = wsRequest.accept(null, wsRequest.origin);
  activeWsConnections.add(connection);
  connection.on('close', () => activeWsConnections.delete(connection));
  mediaWsLogger.info('Media websocket connection accepted', {
    event: 'media-ws-accepted',
  });
  new MediaStream(connection, mediaStreamDeps);
});

/** @type {import('./src/core/media-stream').MediaStreamDeps} */
const mediaStreamDeps = {
  logger: mediaWsLogger,
  state,
  homekit,
  registry: activeMediaStreamsByCallSid,
  verifyStreamToken: verifyAndConsumeStreamToken,
  tokenParameterName: STREAM_TOKEN_PARAMETER_NAME,
  startTimeoutMs: STREAM_START_TIMEOUT_MS,
  maxUtf8Bytes: MAX_WS_UTF8_BYTES,
  mediaPayloadMaxBytes: config.twilioMediaPayloadMaxBytes,
};

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

/**
 * Every side effect that reaches outside the process lives here: publishing the
 * HomeKit accessory, binding the HTTP/WebSocket port, and installing the
 * process-level signal and crash handlers. Module scope above only builds
 * objects and registers in-process callbacks, so requiring this file from a
 * test or the coverage run advertises nothing, binds nothing, and cannot
 * install an uncaughtException handler that would swallow a test failure.
 *
 * homekit.start() comes first so the accessory is on the network before the
 * port accepts a Twilio stream, which is the order the module-scope version
 * produced and the order README's startup log example shows.
 *
 * @returns {void}
 */
function main() {
  homekit.start();

  wsserver.listen(HTTP_SERVER_PORT, () => {
    logger.info('Server listening', {
      event: 'server-start',
      port: HTTP_SERVER_PORT,
    });
  });

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
}

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

if (require.main === module) main();

module.exports = {
  main,
  beginShutdown,
  buildTwiml,
  handleRequest,
  isAuthorizedForStatus,
  isValidTwilioRequest,
  parseFormUrlEncoded,
  readRequestBody,
};
