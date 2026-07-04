---
name: telephony-audio-reference
description: Domain theory pack for the audio path as it applies to this repo — G.711 mu-law, the Twilio Media Streams WebSocket protocol, DTMF, RTP/SRTP/SDP, Opus, and the HAP-NodeJS camera streaming lifecycle. Use when reading or modifying homekit.js, src/core/mulaw-audio.js, src/core/media-stream.js, or src/core/ws-events-schema.js, or when an audio format, payload-type, or SDP question comes up. For symptom triage use intercom-debugging-playbook instead.
---

# Telephony and audio reference (as used HERE)

**Use this skill when** you need the protocol/format knowledge behind the media code — what a mu-law byte is, what Twilio sends over the WebSocket, how SRTP keys are exchanged, why the SDP says `opus/48000/2`.
**Do NOT use it for**: triaging a broken call (`intercom-debugging-playbook`), design rationale (`intercom-architecture-and-invariants`).

## G.711 mu-law (µ-law) — the PSTN format

- 8-bit logarithmic companding of ~14-bit linear PCM. **1 byte = 1 sample. 8000 samples/s. 160 bytes = 20 ms.** Bitrate 64 kbit/s.
- Silence is byte `0xff` (mu-law zero). Buffers in this repo are pre-filled with `0xff`, not `0x00`.
- Encoder/decoder live in `src/core/mulaw-audio.js`: `linear16ToMulaw` (bias `0x84`, clip `32635`) and its inverse `mulawToLinear16`. They are covered by `tests/mulaw-audio.test.cjs`.

## Twilio Media Streams WebSocket protocol

Twilio connects to `wss://{TUNNEL_HOSTNAME}/media` after receiving `<Connect><Stream>` TwiML. Every frame is a JSON envelope with an `event` field. Parsing/validation: `src/core/ws-events-schema.js` (Zod).

| Event         | Direction | Contents (as consumed here)                                                                                               |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `connected`   | inbound   | Handshake; logged, no action.                                                                                             |
| `start`       | inbound   | `start.callSid`, `start.streamSid`, `start.customParameters` (carries the auth `token` from the TwiML `<Parameter>`).     |
| `media`       | inbound   | `media.payload` = base64 mu-law chunk. Decoded size capped at `TWILIO_MEDIA_PAYLOAD_MAX_BYTES` (default 512).             |
| `stop`        | inbound   | Call ended on Twilio's side; triggers teardown.                                                                           |
| anything else | inbound   | Ignored and logged as `media-ws-unsupported-event` (Twilio also emits e.g. `mark`/`dtmf` events this server doesn't use). |

**Outbound** (server → Twilio, `sendMulawAudio` in `mulaw-audio.js`): the server sends the same envelope shape —
`{"event":"media","streamSid":"MZ…","media":{"payload":"<base64 mu-law>"}}` — over the open WebSocket. This is how ringback and unlock DTMF reach the caller. There is no separate outbound channel: **the WebSocket IS the call**.

Hard limits (see `.env.example`): WS frames > `WS_MAX_MESSAGE_BYTES` (4096) close the connection; the `callSid` arrives ONLY in the `start` event, never in HTTP headers.

## DTMF

Dual-tone multi-frequency: each digit is two simultaneous sine tones. Table in `src/core/mulaw-audio.js` (`DTMF_FREQUENCIES`): rows 697/770/852/941 Hz × columns 1209/1336/1477/1633 Hz.

- Defaults: 650 ms tone + 120 ms trailing silence, amplitude 12000.
- Pause characters (Twilio convention): `w` = 500 ms, `W` = 1000 ms. Default unlock sequence `w9w` = pause, dial 9, pause. Valid characters: `0-9 A-D a-d * # w W` (validated in `config.js`).
- `sendDtmfSequence` paces tones in 20 ms chunks with real-time `sleep` between chunks — DTMF is streamed at wall-clock rate, not burst.

## Ringback

UK cadence, generated in `createRingbackMulawCycle`: 400 ms dual tone (400 Hz + 450 Hz) → 200 ms gap → 400 ms tone → 2000 ms tail. While the doorbell rings unanswered, `MediaStream.startRingback` sends one 160-byte (20 ms) frame every 20 ms; it stops when the HomeKit live view opens (`homekit-session-started`). `GET /ringtone` serves the same cycle as a PCM16 WAV for manual checks.

## RTP / SRTP / SDP essentials

- RTP header is 12 bytes. **Payload type (PT) = second byte `& 0x7F`** — this is the field you check with tcpdump when diagnosing outbound audio (README Stage 6).
- SSRC is a 32-bit stream identifier. ffmpeg parses `-ssrc` as a **signed** int, so this repo masks random SSRCs with `& 0x7fffffff` (`randomSSRC` in `homekit.js`).
- SRTP here is always suite `AES_CM_128_HMAC_SHA1_80`. Key material = 16-byte master key + 14-byte salt, concatenated and base64-encoded (30 bytes → `srtpParams` in `homekit.js`); passed to ffmpeg as `-srtp_out_params` (sending) or an SDP `a=crypto:1 … inline:` line (receiving).
- ffmpeg can only **receive** SRTP via an SDP file input; hence `/tmp/intercom_return_<sessionID>.sdp` plus `-protocol_whitelist file,crypto,udp,rtp`.
- **`opus/48000/2` in the SDP is correct even though audio is 16 kHz mono.** RFC 7587 requires the Opus rtpmap to always declare 48000/2 regardless of the encoded bandwidth. Do not "fix" this.

## HAP-NodeJS camera streaming lifecycle

The accessory (`homekit.js`) is a video doorbell (`Categories.VIDEO_DOORBELL`) with a `CameraController` (`cameraStreamCount: 2`) and a delegate implementing three hooks:

1. **`prepareStream(request, cb)`** — the iPhone (controller) sends its address, video/audio ports, and SRTP key+salt. The server allocates a local UDP port for return audio (`returnAudioPort`), generates SSRCs, stores everything in `activeSessions`, and replies with its own ports/SSRCs, echoing the controller's keys.
2. **`handleStreamRequest` type `START`** — the controller confirms codec parameters **including the negotiated payload types** (`request.audio.pt`, `request.video.pt`). Two ffmpeg processes spawn:
   - **Inbound** (`ffIn`): raw mu-law on stdin + synthetic black H.264 → two separate SRTP outputs (video and audio; no muxing, no PTS coupling). IDR forced every second.
   - **Outbound** (`ffOut`): reads the SDP file to receive/decrypt controller SRTP on `returnAudioPort`, decodes Opus, re-encodes mu-law → stdout → wrapped in the Twilio media envelope.
   - **Always use the PT from the START request.** Older code assumed Opus PT 110 and broke when the controller chose otherwise (comment in `homekit.js`).
3. **`RECONFIGURE`** is ignored (static synthetic source); **`STOP`** tears down ffmpeg and hangs up the Twilio call via REST (`twilio-api.js`, error 21220 = already ended).

Doorbell ring = `ProgrammableSwitchEvent.updateValue(0)` (0 = single press). Snapshot requests get a pre-rendered 1280×720 black JPEG.

The mu-law bridge between Twilio and ffIn is a Node `PassThrough` stream (`highWaterMark` 32768) piped into `ffIn.stdin` with `{ end: false }`; binding is logged as `mulaw-stream-bound` / `mulaw-stream-rebound`.

## Provenance and maintenance

Written 2026-07-04 against commit `d377b02`. Re-verify:

- Event schema and limits: `grep -n "z.literal\|maxDecodedBytes" src/core/ws-events-schema.js`
- DTMF/ringback constants: `grep -n "DEFAULT_DTMF\|RINGBACK_\|DTMF_FREQUENCIES" src/core/mulaw-audio.js`
- SDP shape and PT usage: `grep -n "rtpmap\|audio.pt" homekit.js`
- HAP delegate hooks: `grep -n "prepareStream\|handleStreamRequest\|StreamRequestTypes" homekit.js`
