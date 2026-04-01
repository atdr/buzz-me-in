'use strict';

const config = require('./config');

class CallSessionManager {
  constructor(staleSec) {
    this._sessions = new Map();
    this._activeCallSid = null;
    this._staleMs = staleSec * 1000;
    this._onSessionStale = null;

    const tickMs = Math.max(5000, Math.min(30000, Math.floor(this._staleMs / 3)));
    this._reaper = setInterval(() => this._reapStaleSession(), tickMs);
    if (typeof this._reaper.unref === 'function') this._reaper.unref();
  }

  setOnSessionStale(handler) {
    this._onSessionStale = typeof handler === 'function' ? handler : null;
  }

  startCall({ callSid, streamSid, wsConnection }) {
    if (!callSid || !streamSid || !wsConnection) {
      return { ok: false, reason: 'invalid session payload' };
    }
    const active = this.getActiveCall();
    if (active && active.callSid !== callSid) {
      return { ok: false, reason: 'another call is already active' };
    }

    const now = Date.now();
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

  getActiveCall() {
    if (!this._activeCallSid) return null;
    return this._sessions.get(this._activeCallSid) || null;
  }

  getStatus() {
    const active = this.getActiveCall();
    if (!active) return { active: false };
    return { active: true, callSid: active.callSid };
  }

  markActivity(callSid, eventName) {
    const session = callSid ? this._sessions.get(callSid) : this.getActiveCall();
    if (!session) return false;
    session.lastEventAtMs = Date.now();
    if (eventName) session.lastEvent = eventName;
    return true;
  }

  clearActiveCall(reason) {
    const active = this.getActiveCall();
    if (!active) return { cleared: false, session: null };
    this._sessions.delete(active.callSid);
    this._activeCallSid = null;
    return { cleared: true, session: { ...active, clearedReason: reason || 'cleared' } };
  }

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
      console.error('[state] stale session handler failed:', err && err.message ? err.message : err);
    }
  }
}

module.exports = new CallSessionManager(config.callSessionStaleSec);
