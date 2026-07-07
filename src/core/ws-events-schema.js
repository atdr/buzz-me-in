'use strict';

const { z } = require('zod');
const { CALL_SID_REGEX } = require('./twilio-ids');
/** @import { WsEventParseResult, MediaPayloadParseResult } from './types.js' */

const connectedEventSchema = z.object({
  event: z.literal('connected'),
});

const startEventSchema = z.object({
  event: z.literal('start'),
  start: z.object({
    callSid: z.string().regex(CALL_SID_REGEX),
    streamSid: z.string().min(1),
    mediaFormat: z
      .object({
        encoding: z.string().optional(),
        sampleRate: z.number().optional(),
        channels: z.number().optional(),
      })
      .optional(),
    customParameters: z.record(z.string(), z.string()).optional(),
  }),
});

const mediaEventSchema = z.object({
  event: z.literal('media'),
  media: z.object({
    payload: z.string(),
  }),
});

const stopEventSchema = z.object({
  event: z.literal('stop'),
});

const supportedEventSchema = z.discriminatedUnion('event', [
  connectedEventSchema,
  startEventSchema,
  mediaEventSchema,
  stopEventSchema,
]);
/** @type {Set<string>} */
const SUPPORTED_EVENTS = new Set(
  supportedEventSchema.options.map((schema) => schema.shape.event.value)
);

const BASE64_PAYLOAD_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * @param {unknown} raw
 * @returns {WsEventParseResult}
 */
function parseTwilioWsEvent(raw) {
  const base = z.object({ event: z.string().min(1) }).safeParse(raw);
  if (!base.success) {
    return { ok: false, reason: 'missing event field' };
  }

  if (!SUPPORTED_EVENTS.has(base.data.event)) {
    return {
      ok: true,
      unsupported: true,
      event: base.data.event,
    };
  }

  const parsed = supportedEventSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `invalid ${base.data.event} payload` };
  }

  switch (parsed.data.event) {
    case 'connected':
      return { ok: true, unsupported: false, event: 'connected', data: parsed.data };
    case 'start':
      return { ok: true, unsupported: false, event: 'start', data: parsed.data };
    case 'media':
      return { ok: true, unsupported: false, event: 'media', data: parsed.data };
    case 'stop':
      return { ok: true, unsupported: false, event: 'stop', data: parsed.data };
  }
}

/**
 * @param {unknown} payload
 * @param {number} maxDecodedBytes
 * @returns {MediaPayloadParseResult}
 */
function parseTwilioMediaPayload(payload, maxDecodedBytes) {
  if (typeof payload !== 'string') {
    return { ok: false, reason: 'invalid media payload encoding' };
  }
  if (payload.length % 4 !== 0 || !BASE64_PAYLOAD_REGEX.test(payload)) {
    return { ok: false, reason: 'invalid media payload encoding' };
  }

  const decoded = Buffer.from(payload, 'base64');
  if (decoded.length > maxDecodedBytes) {
    return { ok: false, reason: 'media payload too large' };
  }

  return { ok: true, decoded };
}

module.exports = {
  parseTwilioWsEvent,
  parseTwilioMediaPayload,
};
