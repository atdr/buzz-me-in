'use strict';

const { z } = require('zod');

const connectedEventSchema = z.object({
  event: z.literal('connected'),
});

const startEventSchema = z.object({
  event: z.literal('start'),
  start: z.object({
    callSid: z.string().min(1),
    streamSid: z.string().min(1),
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

const BASE64_PAYLOAD_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function parseTwilioWsEvent(raw) {
  const base = z.object({ event: z.string().min(1) }).safeParse(raw);
  if (!base.success) {
    return { ok: false, reason: 'missing event field' };
  }

  if (!['connected', 'start', 'media', 'stop'].includes(base.data.event)) {
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

  return {
    ok: true,
    unsupported: false,
    event: parsed.data.event,
    data: parsed.data,
  };
}

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
