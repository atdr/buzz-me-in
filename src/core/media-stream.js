'use strict';

/**
 * Twilio media stream session: one instance per accepted WebSocket
 * connection. Handles the Twilio event protocol (connected/start/media/stop),
 * stream token verification, ringback, and teardown.
 *
 * External integrations (call state, HomeKit, logging) are injected so the
 * protocol logic can be unit-tested with fakes.
 */

const { PassThrough } = require('stream');
const { parseTwilioWsEvent, parseTwilioMediaPayload } = require('./ws-events-schema');
const { createRingbackMulawCycle, sendMulawAudio } = require('./mulaw-audio');

/** @import { connection, Message } from 'websocket' */
/** @import { WsEventParseOkSupported, StreamTokenVerificationResult, TokenVerificationError, WsEventParseError, MediaPayloadParseError } from './types' */

/**
 * @typedef {object} MediaStreamDeps
 * @property {ReturnType<typeof import('./log').createLogger>} logger
 * @property {typeof import('./state')} state
 * @property {{ setMulawPassthrough: (stream: PassThrough) => number, triggerDoorbell: () => void, clearMulawPassthrough: (stream: PassThrough) => void, endHapSession: () => void }} homekit
 * @property {Map<string, MediaStream>} registry map of callSid → MediaStream
 * @property {(token: string) => StreamTokenVerificationResult} verifyStreamToken
 * @property {string} tokenParameterName
 * @property {number} startTimeoutMs
 * @property {number} maxUtf8Bytes
 * @property {number} mediaPayloadMaxBytes
 */

class MediaStream {
  /**
   * @param {connection} connection
   * @param {MediaStreamDeps} deps
   */
  constructor(connection, deps) {
    this.connection = connection;
    this.deps = deps;
    this.logger = deps.logger;
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
        this.logger.warn('Media websocket start timed out', {
          event: 'start',
          reason: 'start-timeout',
        });
        this.connection.close();
      }
    }, deps.startTimeoutMs);
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
    if (message.utf8Data.length > this.deps.maxUtf8Bytes) {
      this.logger.warn('Media websocket message too large', {
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
      this.logger.warn('Media websocket invalid JSON', {
        event: 'media-ws-invalid-json',
        reason: 'json-parse-failed',
      });
      this.connection.close();
      return;
    }

    const parsedResult = parseTwilioWsEvent(rawData);
    if (!parsedResult.ok) {
      const parsedError = /** @type {WsEventParseError} */ (parsedResult);
      this.logger.warn('Media websocket invalid event payload', {
        event: 'media-ws-invalid-event-payload',
        reason: parsedError.reason,
      });
      this.connection.close();
      return;
    }
    if (parsedResult.unsupported) {
      this.logger.info('Media websocket unsupported event ignored', {
        event: 'media-ws-unsupported-event',
        reason: parsedResult.event,
      });
      this.messageCount++;
      return;
    }
    const parsed = /** @type {WsEventParseOkSupported} */ (parsedResult);

    switch (parsed.event) {
      case 'connected': {
        this.logger.info('Media websocket connected event', {
          event: 'connected',
        });
        break;
      }

      case 'start': {
        this._handleStart(parsed.data.start);
        break;
      }

      case 'media': {
        this._handleMedia(parsed.data.media);
        break;
      }

      case 'stop': {
        this.logger.info('Media websocket stop event', {
          callSid: this.currentCallSid || undefined,
          event: 'stop',
        });
        this._teardown('twilio-stop');
        break;
      }
    }

    this.messageCount++;
  }

  /**
   * @param {{ callSid: string, streamSid: string, customParameters?: Record<string, string> }} start
   */
  _handleStart(start) {
    if (this.started) {
      this.logger.warn('Duplicate media websocket start event', {
        event: 'start',
        reason: 'duplicate-start',
      });
      this.connection.close();
      return;
    }
    const token = start.customParameters
      ? start.customParameters[this.deps.tokenParameterName]
      : undefined;
    const verification = this.deps.verifyStreamToken(typeof token === 'string' ? token : '');
    if (!verification.ok) {
      const verificationError = /** @type {TokenVerificationError} */ (verification);
      this.logger.warn('Media websocket start rejected', {
        callSid: start.callSid,
        event: 'start',
        reason: verificationError.reason,
      });
      this.connection.close();
      return;
    }
    if (verification.callSid && verification.callSid !== start.callSid) {
      this.logger.warn('Media websocket start rejected', {
        callSid: start.callSid,
        event: 'start',
        reason: 'callsid-mismatch',
      });
      this.connection.close();
      return;
    }
    const started = this.deps.state.startCall({
      callSid: start.callSid,
      streamSid: start.streamSid,
      wsConnection: this.connection,
    });
    if (started.ok === false) {
      this.logger.warn('Media websocket start rejected', {
        callSid: start.callSid,
        event: 'start',
        reason: started.reason,
      });
      this.connection.close();
      return;
    }
    this.logger.info('Media websocket start accepted', {
      callSid: start.callSid,
      event: 'start',
      streamSid: start.streamSid,
    });
    clearTimeout(this.startTimeout);
    this.currentCallSid = start.callSid;
    this.started = true;
    this.deps.registry.set(start.callSid, this);
    const reboundSessionCount = this.deps.homekit.setMulawPassthrough(this.mulawStream);
    if (reboundSessionCount > 0) {
      this.markHomekitSessionStarted();
    } else {
      this.deps.homekit.triggerDoorbell();
      this.startRingback();
    }
  }

  /**
   * @param {{ payload: string }} media
   */
  _handleMedia(media) {
    if (!this.started || !this.currentCallSid) {
      this.logger.warn('Media frame before start event', {
        event: 'media',
        reason: 'media-before-start',
      });
      this.connection.close();
      return;
    }
    const mediaPayload = parseTwilioMediaPayload(media.payload, this.deps.mediaPayloadMaxBytes);
    if (!mediaPayload.ok) {
      const mediaPayloadError = /** @type {MediaPayloadParseError} */ (mediaPayload);
      this.logger.warn('Media payload rejected', {
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
          this.logger.warn('Dropping media frames; mulaw buffer is full', {
            callSid: this.currentCallSid,
            event: 'media-frames-dropped',
            reason: 'mulaw-buffer-full',
          });
        }
      } else {
        if (this.droppingFrames) {
          this.droppingFrames = false;
          this.logger.info('Resumed forwarding media frames', {
            callSid: this.currentCallSid,
            event: 'media-frames-resumed',
          });
        }
        this.mulawStream.write(mediaPayload.decoded);
      }
    }
    this.deps.state.markActivity(this.currentCallSid, 'twilio-media');
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
    this.logger.info('Ringback media stopped', {
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

    const activeCall = this.deps.state.getActiveCall();
    if (!activeCall || activeCall.wsConnection !== this.connection || !activeCall.streamSid) return;
    sendMulawAudio(activeCall, chunk);
  }

  _teardown(reason) {
    if (this.closed) return;
    this.closed = true;
    this.stopRingback(reason);
    this.logger.info('Media websocket session ended', {
      callSid: this.currentCallSid || undefined,
      event: 'session-ended',
      reason,
      messageCount: this.messageCount,
    });
    clearTimeout(this.startTimeout);
    // Guard: close() can fire without a prior 'stop' event (e.g. network drop).
    this.deps.homekit.clearMulawPassthrough(this.mulawStream);
    this.mulawStream.destroy();
    const { cleared } = this.deps.state.clearIfConnection(this.connection, reason);
    if (this.currentCallSid && this.deps.registry.get(this.currentCallSid) === this) {
      this.deps.registry.delete(this.currentCallSid);
    }
    if (cleared) {
      this.deps.homekit.endHapSession();
    }
  }
}

module.exports = { MediaStream };
