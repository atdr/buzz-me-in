'use strict';

/**
 * Shared JSDoc typedefs for runtime JS type-checking.
 * This file is intentionally declarations-only; no runtime exports.
 */

/**
 * @typedef {'connected' | 'start' | 'media' | 'dtmf' | 'stop'} SupportedWsEventName
 */

/**
 * @typedef {{ event: 'connected' }} ConnectedEvent
 */

/**
 * @typedef {{
 *   event: 'start',
 *   start: { callSid: string, streamSid: string, customParameters?: Record<string, string> }
 * }} StartEvent
 */

/**
 * @typedef {{
 *   event: 'media',
 *   media: { payload: string }
 * }} MediaEvent
 */

/**
 * @typedef {{
 *   event: 'dtmf',
 *   dtmf?: { digit?: string, track?: string }
 * }} DtmfEvent
 */

/**
 * @typedef {{ event: 'stop' }} StopEvent
 */

/**
 * @typedef {ConnectedEvent | StartEvent | MediaEvent | DtmfEvent | StopEvent} SupportedWsEventData
 */

/**
 * @typedef {{
 *   ok: true,
 *   unsupported: false,
 *   event: 'connected',
 *   data: ConnectedEvent
 * } | {
 *   ok: true,
 *   unsupported: false,
 *   event: 'start',
 *   data: StartEvent
 * } | {
 *   ok: true,
 *   unsupported: false,
 *   event: 'media',
 *   data: MediaEvent
 * } | {
 *   ok: true,
 *   unsupported: false,
 *   event: 'dtmf',
 *   data: DtmfEvent
 * } | {
 *   ok: true,
 *   unsupported: false,
 *   event: 'stop',
 *   data: StopEvent
 * }} WsEventParseOkSupported
 */

/**
 * @typedef {{
 *   ok: true,
 *   unsupported: true,
 *   event: string
 * }} WsEventParseOkUnsupported
 */

/**
 * @typedef {{
 *   ok: false,
 *   reason: string
 * }} WsEventParseError
 */

/**
 * @typedef {WsEventParseOkSupported | WsEventParseOkUnsupported | WsEventParseError} WsEventParseResult
 */

/**
 * @typedef {{ ok: true, decoded: Buffer }} MediaPayloadParseOk
 */

/**
 * @typedef {{ ok: false, reason: string }} MediaPayloadParseError
 */

/**
 * @typedef {MediaPayloadParseOk | MediaPayloadParseError} MediaPayloadParseResult
 */

/**
 * @typedef {{ ok: true, callSid: string | null }} TokenVerificationOk
 */

/**
 * @typedef {{ ok: false, reason: string }} TokenVerificationError
 */

/**
 * @typedef {TokenVerificationOk | TokenVerificationError} StreamTokenVerificationResult
 */

/**
 * @typedef {{
 *   callSid: string,
 *   streamSid: string,
 *   wsConnection: import('websocket').connection,
 *   createdAtMs: number,
 *   lastEventAtMs: number,
 *   lastEvent: string
 * }} CallSession
 */

/**
 * @typedef {CallSession & { clearedReason: string }} ClearedCallSession
 */

/**
 * @typedef {{ active: false } | { active: true, callSid: string }} CallStatus
 */

/**
 * @typedef {{ ok: true, session: CallSession } | { ok: false, reason: string }} StartCallResult
 */

/**
 * @typedef {{ cleared: true, session: ClearedCallSession } | { cleared: false, session: null }} ClearCallResult
 */

/**
 * @typedef {{
 *   ts?: string,
 *   level?: 'debug' | 'info' | 'warn' | 'error',
 *   message?: string,
 *   component?: string,
 *   callSid?: string,
 *   event?: string,
 *   reason?: string,
 *   durationMs?: number
 * } & Record<string, unknown>} LogFields
 */

module.exports = {};
