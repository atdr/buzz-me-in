'use strict';

const SAMPLE_RATE_HZ = 8000;
const DEFAULT_DTMF_TONE_MS = 650;
const DEFAULT_DTMF_TRAILING_SILENCE_MS = 120;
const DEFAULT_CHUNK_MS = 20;
const DEFAULT_SHORT_PAUSE_MS = 500;
const DEFAULT_LONG_PAUSE_MS = 1000;
const RINGBACK_BURST_MS = 400;
const RINGBACK_GAP_MS = 200;
const RINGBACK_TAIL_MS = 2000;
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

const DTMF_FREQUENCIES = {
  1: [697, 1209],
  2: [697, 1336],
  3: [697, 1477],
  A: [697, 1633],
  4: [770, 1209],
  5: [770, 1336],
  6: [770, 1477],
  B: [770, 1633],
  7: [852, 1209],
  8: [852, 1336],
  9: [852, 1477],
  C: [852, 1633],
  '*': [941, 1209],
  0: [941, 1336],
  '#': [941, 1477],
  D: [941, 1633],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {number} sample
 * @returns {number}
 */
function linear16ToMulaw(sample) {
  let sign = 0;
  let magnitude = Math.round(sample);

  if (magnitude < 0) {
    sign = 0x80;
    magnitude = -magnitude;
  }
  if (magnitude > MULAW_CLIP) magnitude = MULAW_CLIP;

  magnitude += MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (magnitude & mask) === 0; mask >>= 1) {
    exponent--;
  }

  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/**
 * Generate a Twilio-compatible raw mu-law/8kHz DTMF tone.
 *
 * @param {string | number} digit
 * @param {{ toneMs?: number, trailingSilenceMs?: number, amplitude?: number }} [options]
 * @returns {Buffer}
 */
function createDtmfMulawTone(digit, options = {}) {
  const normalizedDigit = String(digit).toUpperCase();
  const frequencies = DTMF_FREQUENCIES[normalizedDigit];
  if (!frequencies) {
    throw new Error(`Unsupported DTMF digit: ${digit}`);
  }

  const toneMs = options.toneMs ?? DEFAULT_DTMF_TONE_MS;
  const trailingSilenceMs = options.trailingSilenceMs ?? DEFAULT_DTMF_TRAILING_SILENCE_MS;
  const amplitude = options.amplitude ?? 12000;
  const toneSamples = Math.round((SAMPLE_RATE_HZ * toneMs) / 1000);
  const silenceSamples = Math.round((SAMPLE_RATE_HZ * trailingSilenceMs) / 1000);
  const payload = Buffer.alloc(toneSamples + silenceSamples, 0xff);
  const [lowFrequency, highFrequency] = frequencies;

  for (let i = 0; i < toneSamples; i++) {
    const t = i / SAMPLE_RATE_HZ;
    const sample =
      (amplitude *
        (Math.sin(2 * Math.PI * lowFrequency * t) + Math.sin(2 * Math.PI * highFrequency * t))) /
      2;
    payload[i] = linear16ToMulaw(sample);
  }

  return payload;
}

/**
 * Generate one UK-style ringback cycle as raw mu-law/8kHz audio:
 * 400 ms tone, 200 ms silence, 400 ms tone, 2000 ms silence.
 *
 * @returns {Buffer}
 */
function createRingbackMulawCycle() {
  const burst = createDualToneMulaw(400, 450, RINGBACK_BURST_MS, 9000);
  const gap = Buffer.alloc(Math.round((SAMPLE_RATE_HZ * RINGBACK_GAP_MS) / 1000), 0xff);
  const tail = Buffer.alloc(Math.round((SAMPLE_RATE_HZ * RINGBACK_TAIL_MS) / 1000), 0xff);
  return Buffer.concat([burst, gap, burst, tail]);
}

/**
 * @param {number} lowFrequency
 * @param {number} highFrequency
 * @param {number} durationMs
 * @param {number} amplitude
 * @returns {Buffer}
 */
function createDualToneMulaw(lowFrequency, highFrequency, durationMs, amplitude) {
  const samples = Math.round((SAMPLE_RATE_HZ * durationMs) / 1000);
  const payload = Buffer.alloc(samples);

  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE_HZ;
    const sample =
      (amplitude *
        (Math.sin(2 * Math.PI * lowFrequency * t) + Math.sin(2 * Math.PI * highFrequency * t))) /
      2;
    payload[i] = linear16ToMulaw(sample);
  }

  return payload;
}

/**
 * @param {{ streamSid: string, wsConnection: { sendUTF: (message: string) => void, sendMediaPayload?: (payload: Buffer, options?: { source?: string }) => void } }} activeCall
 * @param {Buffer} payload
 * @param {{ source?: string }} [options]
 */
function sendMulawAudio(activeCall, payload, options = {}) {
  if (!activeCall || !activeCall.streamSid || !activeCall.wsConnection) {
    throw new Error('Cannot send audio without an active media stream');
  }
  if (typeof activeCall.wsConnection.sendMediaPayload === 'function') {
    activeCall.wsConnection.sendMediaPayload(payload, options);
    return;
  }
  activeCall.wsConnection.sendUTF(
    JSON.stringify({
      event: 'media',
      streamSid: activeCall.streamSid,
      media: { payload: payload.toString('base64') },
    })
  );
}

/**
 * @param {{ streamSid: string, wsConnection: { sendUTF: (message: string) => void, sendMediaPayload?: (payload: Buffer, options?: { source?: string }) => void, beginDtmf?: () => void, endDtmf?: () => void } }} activeCall
 * @param {string} digits
 * @param {{ chunkMs?: number, toneMs?: number, trailingSilenceMs?: number, shortPauseMs?: number, longPauseMs?: number }} [options]
 */
async function sendDtmfSequence(activeCall, digits, options = {}) {
  if (!activeCall || !activeCall.streamSid || !activeCall.wsConnection) {
    throw new Error('Cannot send DTMF without an active media stream');
  }

  const chunkMs = options.chunkMs ?? DEFAULT_CHUNK_MS;
  const chunkSize = Math.max(1, Math.round((SAMPLE_RATE_HZ * chunkMs) / 1000));
  const shortPauseMs = options.shortPauseMs ?? DEFAULT_SHORT_PAUSE_MS;
  const longPauseMs = options.longPauseMs ?? DEFAULT_LONG_PAUSE_MS;

  if (typeof activeCall.wsConnection.beginDtmf === 'function') activeCall.wsConnection.beginDtmf();
  try {
    for (const digit of String(digits)) {
      if (digit === 'w') {
        await sleep(shortPauseMs);
        continue;
      }
      if (digit === 'W') {
        await sleep(longPauseMs);
        continue;
      }

      const payload = createDtmfMulawTone(digit, options);
      for (let offset = 0; offset < payload.length; offset += chunkSize) {
        const chunk = payload.subarray(offset, offset + chunkSize);
        sendMulawAudio(activeCall, chunk, { source: 'dtmf' });
        await sleep(chunkMs);
      }
    }
  } finally {
    if (typeof activeCall.wsConnection.endDtmf === 'function') activeCall.wsConnection.endDtmf();
  }
}

module.exports = {
  createDtmfMulawTone,
  createRingbackMulawCycle,
  linear16ToMulaw,
  sendDtmfSequence,
  sendMulawAudio,
};
