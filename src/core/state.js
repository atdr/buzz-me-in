'use strict';

const config = require('./config');

/** @import { connection as WebSocketConnection } from 'websocket' */
/** @import { CallSession, CallStatus, StartCallResult, ClearCallResult, ClearedCallSession } from './types.js' */

class CallSessionManager {
  /**
   * @param {number} staleSec
   */
  constructor(staleSec) {
    /** @type {Map<string, CallSession>} */
    this._sessions = new Map();
    /** @type {string | null} */
    this._activeCallSid = null;
    this._staleMs = staleSec * 1000;
    /** @type {((session: ClearedCallSession) => void) | null} */
    this._onSessionStale = null;

    const tickMs = Math.max(5000, Math.min(30000, Math.floor(this._staleMs / 3)));
    this._reaper = setInterval(() => this._reapStaleSession(), tickMs);
    if (typeof this._reaper.unref === 'function') this._reaper.unref();
  }

  /**
   * @param {((session: ClearedCallSession) => void) | null | undefined} handler
   */
  setOnSessionStale(handler) {
    this._onSessionStale = typeof handler === 'function' ? handler : null;
  }

  /**
   * @param {{ callSid: string, streamSid: string, wsConnection: WebSocketConnection }} input
   * @returns {StartCallResult}
   */
  startCall({ callSid, streamSid, wsConnection }) {
    if (!callSid || !streamSid || !wsConnection) {
      return { ok: false, reason: 'invalid session payload' };
    }
    const active = this.getActiveCall();
    if (active && active.callSid !== callSid) {
      return { ok: false, reason: 'another call is already active' };
    }

    const now = Date.now();
    /** @type {CallSession} */
    const session = {
      callSid,
      streamSid,
      wsConnection,
      createdAtMs: now,
      lastEventAtMs: now,
      lastEvent: 'start',
    };

    this._sessions.set(callSid, session);
    this._activeCallSid = callSid;
    return { ok: true, session };
  }

  /**
   * @returns {CallSession | null}
   */
  getActiveCall() {
    if (!this._activeCallSid) return null;
    return this._sessions.get(this._activeCallSid) || null;
  }

  /**
   * @returns {CallStatus}
   */
  getStatus() {
    const active = this.getActiveCall();
    if (!active) return { active: false };
    return { active: true, callSid: active.callSid };
  }

  /**
   * @param {string | null | undefined} callSid
   * @param {string | null | undefined} eventName
   * @returns {boolean}
   */
  markActivity(callSid, eventName) {
    const session = callSid ? this._sessions.get(callSid) : this.getActiveCall();
    if (!session) return false;
    session.lastEventAtMs = Date.now();
    if (eventName) session.lastEvent = eventName;
    return true;
  }

  /**
   * @param {string | null | undefined} reason
   * @returns {ClearCallResult}
   */
  clearActiveCall(reason) {
    const active = this.getActiveCall();
    if (!active) return { cleared: false, session: null };
    this._sessions.delete(active.callSid);
    this._activeCallSid = null;
    return { cleared: true, session: { ...active, clearedReason: reason || 'cleared' } };
  }

  /**
   * @param {WebSocketConnection} wsConnection
   * @param {string | null | undefined} reason
   * @returns {ClearCallResult}
   */
  clearIfConnection(wsConnection, reason) {
    const active = this.getActiveCall();
    if (!active || active.wsConnection !== wsConnection) {
      return { cleared: false, session: null };
    }
    return this.clearActiveCall(reason || 'connection-closed');
  }

  stop() {
    if (this._reaper) {
      clearInterval(this._reaper);
      this._reaper = null;
    }
    this._sessions.clear();
    this._activeCallSid = null;
  }

  _reapStaleSession() {
    const active = this.getActiveCall();
    if (!active) return;
    if (Date.now() - active.lastEventAtMs <= this._staleMs) return;

    const { cleared, session } = this.clearActiveCall('stale-timeout');
    if (!cleared || !this._onSessionStale) return;

    try {
      this._onSessionStale(session);
    } catch (err) {
      console.error(
        '[state] stale session handler failed:',
        err && err.message ? err.message : err
      );
    }
  }
}

module.exports = new CallSessionManager(config.callSessionStaleSec);
