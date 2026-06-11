'use strict';

const SAMPLE_RATE_HZ = 8000;
const DEFAULT_DTMF_TONE_MS = 650;
const DEFAULT_DTMF_TRAILING_SILENCE_MS = 120;
const DEFAULT_CHUNK_MS = 20;
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
 * Inverse of {@link linear16ToMulaw}.
 *
 * @param {number} mulawByte
 * @returns {number}
 */
function mulawToLinear16(mulawByte) {
  const u = ~mulawByte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  return sign ? -magnitude : magnitude;
}

/**
 * One ringback cycle as a PCM16/8kHz mono WAV file, for serving the
 * ringtone over HTTP without shelling out to ffmpeg.
 *
 * @returns {Buffer}
 */
function createRingbackWav() {
  const mulaw = createRingbackMulawCycle();
  const pcm = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    pcm.writeInt16LE(mulawToLinear16(mulaw[i]), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE_HZ, 24);
  header.writeUInt32LE(SAMPLE_RATE_HZ * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
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

/**
 * @param {{ streamSid: string, wsConnection: { sendUTF: (message: string) => void } }} activeCall
 * @param {string} digits
 * @param {{ chunkMs?: number, toneMs?: number, trailingSilenceMs?: number }} [options]
 */
async function sendDtmfSequence(activeCall, digits, options = {}) {
  if (!activeCall || !activeCall.streamSid || !activeCall.wsConnection) {
    throw new Error('Cannot send DTMF without an active media stream');
  }

  const chunkMs = options.chunkMs ?? DEFAULT_CHUNK_MS;
  const chunkSize = Math.max(1, Math.round((SAMPLE_RATE_HZ * chunkMs) / 1000));

  for (const digit of String(digits)) {
    if (digit === 'w') {
      await sleep(500);
      continue;
    }
    if (digit === 'W') {
      await sleep(1000);
      continue;
    }

    const payload = createDtmfMulawTone(digit, options);
    for (let offset = 0; offset < payload.length; offset += chunkSize) {
      const chunk = payload.subarray(offset, offset + chunkSize);
      sendMulawAudio(activeCall, chunk);
      await sleep(chunkMs);
    }
  }
}

module.exports = {
  createDtmfMulawTone,
  createRingbackMulawCycle,
  createRingbackWav,
  linear16ToMulaw,
  mulawToLinear16,
  sendDtmfSequence,
  sendMulawAudio,
};
