'use strict';

const SAMPLE_RATE_HZ = 8000;
const RINGBACK_BURST_MS = 400;
const RINGBACK_GAP_MS = 200;
const RINGBACK_TAIL_MS = 2000;
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

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
 * @param {{ streamSid: string, wsConnection: { sendUTF: (message: string) => void } }} activeCall
 * @param {Buffer} payload
 */
function sendMulawAudio(activeCall, payload) {
  if (!activeCall || !activeCall.streamSid || !activeCall.wsConnection) {
    throw new Error('Cannot send audio without an active media stream');
  }
  activeCall.wsConnection.sendUTF(
    JSON.stringify({
      event: 'media',
      streamSid: activeCall.streamSid,
      media: { payload: payload.toString('base64') },
    })
  );
}

module.exports = {
  createRingbackMulawCycle,
  linear16ToMulaw,
  sendMulawAudio,
};
