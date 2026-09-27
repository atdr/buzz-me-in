'use strict';

// Guards the inbound ffmpeg arguments. Both #102 fixes are a single flag each,
// and losing either brings back a fault that is only audible on a live call:
// without the probing flags the caller's first ~3 s are lost in a startup
// burst, and without the setts relabel the controller drops words throughout.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildInboundFfmpegArgs } = require('../src/core/inbound-ffmpeg-args.js');

const INPUT = {
  video: { max_bit_rate: 299, mtu: 1378, fps: 30, pt: 99 },
  audio: { pt: 110 },
  videoParams: 'dmlkZW8ta2V5',
  audioParams: 'YXVkaW8ta2V5',
  targetAddress: '192.168.1.207',
  hkVideoPort: 51368,
  hkAudioPort: 59947,
  videoSsrc: 724732488,
  audioSsrc: 1084775967,
};

/** The value following `flag` in `args`. */
function valueAfter(args, flag) {
  const i = args.indexOf(flag);
  assert.notEqual(i, -1, `${flag} missing`);
  return args[i + 1];
}

/** Arguments belonging to input 0 (mu-law on stdin), up to its -i. */
function mulawInputArgs(args) {
  return args.slice(0, args.indexOf('pipe:0') + 1);
}

/** Arguments belonging to the audio output, from its -map to its URL. */
function audioOutputArgs(args) {
  const start = args.indexOf('0:a') - 1;
  const end = args.findIndex((a, i) => i > start && a.startsWith('srtp://'));
  return args.slice(start, end + 1);
}

test('inbound ffmpeg arguments', async (t) => {
  const args = buildInboundFfmpegArgs(INPUT);

  await t.test('mu-law input skips stream probing (#102 startup burst)', () => {
    const input = mulawInputArgs(args);
    assert.equal(valueAfter(input, '-probesize'), '32');
    assert.equal(valueAfter(input, '-analyzeduration'), '0');
    assert.equal(valueAfter(input, '-f'), 'mulaw');
    assert.equal(valueAfter(input, '-ar'), '8000');
    assert.equal(valueAfter(input, '-ch_layout'), 'mono');
    // nobuffer on a pipe input keeps a constant ~3 s delay; keep it out.
    assert.ok(!input.includes('nobuffer'));
  });

  await t.test('Opus RTP is clocked at 16 kHz for HomeKit (#102 dropouts)', () => {
    const audio = audioOutputArgs(args);
    assert.equal(valueAfter(audio, '-c:a'), 'libopus');
    assert.equal(valueAfter(audio, '-ar'), '16000');
    assert.equal(valueAfter(audio, '-frame_duration'), '20');
    assert.equal(valueAfter(audio, '-bsf:a'), 'setts=time_base=1/48000');
  });

  await t.test('audio output targets the controller with its payload type and SSRC', () => {
    const audio = audioOutputArgs(args);
    assert.equal(valueAfter(audio, '-payload_type'), '110');
    assert.equal(valueAfter(audio, '-ssrc'), '1084775967');
    assert.equal(valueAfter(audio, '-srtp_out_params'), INPUT.audioParams);
    assert.equal(
      audio[audio.length - 1],
      'srtp://192.168.1.207:59947?rtcpport=59947&localrtcpport=59947'
    );
  });

  await t.test('video output follows the negotiated bitrate, fps and MTU', () => {
    assert.equal(valueAfter(args, '-b:v'), '299k');
    assert.equal(valueAfter(args, '-maxrate'), '299k');
    assert.equal(valueAfter(args, '-bufsize'), '598k');
    assert.equal(valueAfter(args, '-g'), '30');
    assert.equal(valueAfter(args, '-keyint_min'), '30');
    assert.equal(valueAfter(args, '-payload_type'), '99');
    assert.equal(valueAfter(args, '-ssrc'), '724732488');
    assert.equal(valueAfter(args, '-srtp_out_params'), INPUT.videoParams);
    assert.ok(
      args.includes('srtp://192.168.1.207:51368?rtcpport=51368&localrtcpport=51368&pkt_size=1378')
    );
  });

  await t.test('video falls back to defaults when the request omits them', () => {
    const fallback = buildInboundFfmpegArgs({ ...INPUT, video: { pt: 99 } });
    assert.equal(valueAfter(fallback, '-b:v'), '200k');
    assert.equal(valueAfter(fallback, '-bufsize'), '400k');
    assert.equal(valueAfter(fallback, '-g'), '15');
    assert.ok(fallback.some((a) => a.endsWith('&pkt_size=1316')));
  });

  await t.test('video bitrate has a floor of 64k and buffer a floor of 128k', () => {
    const low = buildInboundFfmpegArgs({ ...INPUT, video: { max_bit_rate: 10, pt: 99 } });
    assert.equal(valueAfter(low, '-b:v'), '64k');
    assert.equal(valueAfter(low, '-bufsize'), '128k');
  });
});
