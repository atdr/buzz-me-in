'use strict';

/**
 * Argument list for the inbound ffmpeg process: Twilio mu-law on stdin →
 * Opus/SRTP audio plus a synthetic H.264/SRTP video track to the controller.
 * Kept apart from homekit.js so the arguments can be tested without spawning
 * ffmpeg or standing up a HomeKit session.
 */

/**
 * @param {{
 *   video: { max_bit_rate?: number, mtu?: number, fps?: number, pt: number },
 *   audio: { pt: number },
 *   videoParams: string,
 *   audioParams: string,
 *   targetAddress: string,
 *   hkVideoPort: number,
 *   hkAudioPort: number,
 *   videoSsrc: number,
 *   audioSsrc: number,
 * }} input
 * @returns {string[]}
 */
function buildInboundFfmpegArgs(input) {
  const { video, audio, videoParams, audioParams } = input;
  const videoBitrate = Math.max(64, video.max_bit_rate || 200);
  const videoBufferSize = Math.max(videoBitrate * 2, 128);
  const mtu = video.mtu || 1316;

  // -------------------------------------------------------------------------
  // Inbound ffmpeg
  //
  // Input 0  – raw mulaw/8kHz from Twilio via stdin
  //   Let the raw audio demuxer derive PTS from sample count. Using wall-clock
  //   timestamps breaks when ffmpeg drains the buffered startup audio burst.
  //   -ch_layout declares mono rather than -ac counting one channel: a count
  //   leaves the layout unset, so the decoder guesses it and logs "Guessed
  //   Channel Layout: mono" on every call. Our stderr handler is a warn, so
  //   that guess looked like a fault in the journal. Needs ffmpeg >= 5.1.
  //   -probesize 32 / -analyzeduration 0 skip stream probing: format, rate
  //   and layout are all declared, but by default ffmpeg still reads ~3 s of
  //   stdin before it outputs anything, then sends that backlog to the
  //   controller in one burst, and the caller's first words are lost (#102).
  //
  // Input 1  – synthetic black video (lavfi color source)
  //   Generates H.264 Baseline/3.1 frames at 15 fps.
  //   HomeKit requires a video track; there is no real camera feed.
  //   keyint_min=15 / -g 15 forces an IDR frame every second — HomeKit
  //   requests it when the live view is first opened; without frequent IDRs
  //   the video stays blank until the next natural keyframe.
  //
  // Two separate SRTP outputs — no muxing, no pts coupling between streams.
  // -------------------------------------------------------------------------
  return [
    '-y',
    '-loglevel',
    'warning',

    // ---- Input 0: raw mulaw from Twilio ----
    '-thread_queue_size',
    '512',
    '-probesize',
    '32',
    '-analyzeduration',
    '0',
    '-f',
    'mulaw',
    '-ar',
    '8000',
    '-ch_layout',
    'mono',
    '-i',
    'pipe:0',

    // ---- Input 1: blank video ----
    '-f',
    'lavfi',
    '-i',
    'color=black:s=1280x720:r=15',

    // ---- Video output → HomeKit SRTP ----
    '-map',
    '1:v',
    '-c:v',
    'libx264',
    '-profile:v',
    'baseline',
    '-level:v',
    '3.1',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    `${videoBitrate}k`,
    '-maxrate',
    `${videoBitrate}k`,
    '-bufsize',
    `${videoBufferSize}k`,
    '-g',
    String(video.fps || 15),
    '-keyint_min',
    String(video.fps || 15),
    '-payload_type',
    String(video.pt),
    '-ssrc',
    String(input.videoSsrc),
    '-f',
    'rtp',
    '-srtp_out_suite',
    'AES_CM_128_HMAC_SHA1_80',
    '-srtp_out_params',
    videoParams,
    `srtp://${input.targetAddress}:${input.hkVideoPort}?rtcpport=${input.hkVideoPort}&localrtcpport=${input.hkVideoPort}&pkt_size=${mtu}`,

    // ---- Audio output → HomeKit SRTP (Opus/16kHz) ----
    //
    // Note on codec choice: libopus is in every standard ffmpeg build.
    // If you prefer AAC-ELD (required by some older HomeKit devices), compile
    // ffmpeg with --enable-libfdk-aac --enable-nonfree and change:
    //   '-c:a', 'libfdk_aac', '-profile:a', 'aac_eld',
    // and update streamingOptions.audio.codecs below to AAC_ELD.
    //
    // RTP clock: HomeKit clocks Opus RTP timestamps at the negotiated sample
    // rate (16 kHz, 320 ticks per 20 ms packet), which is also what the iPhone
    // sends on the return leg. ffmpeg's RTP muxer always uses RFC 7587's
    // 48 kHz for Opus (960 ticks), so the controller saw audio arriving three
    // times slower than its timestamps said, and dropped words (#102).
    // libopus stamps packets in 1/16000; relabelling that time base as
    // 1/48000 stops the muxer rescaling, so each packet advances by 320.
    '-map',
    '0:a',
    '-c:a',
    'libopus',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-b:a',
    '24k',
    '-application',
    'voip',
    '-frame_duration',
    '20',
    '-bsf:a',
    'setts=time_base=1/48000',
    '-payload_type',
    String(audio.pt),
    '-ssrc',
    String(input.audioSsrc),
    '-f',
    'rtp',
    '-srtp_out_suite',
    'AES_CM_128_HMAC_SHA1_80',
    '-srtp_out_params',
    audioParams,
    `srtp://${input.targetAddress}:${input.hkAudioPort}?rtcpport=${input.hkAudioPort}&localrtcpport=${input.hkAudioPort}`,
  ];
}

module.exports = { buildInboundFfmpegArgs };
