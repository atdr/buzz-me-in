---
name: intercom-architecture-and-invariants
description: Load-bearing design decisions (with rationale), system invariants, and known weak points of the Twilio↔HomeKit intercom bridge. Use before changing call flow, session management, auth, TwiML generation, or the ffmpeg pipelines — or whenever a proposed change might touch the single-active-call, one-port, or token-auth design. For the component list see docs/architecture.md; for symptom triage use intercom-debugging-playbook.
---

# Architecture contract: decisions, invariants, weak points

**Use this skill when** you are about to change how the system works (call flow, sessions, auth, media, TwiML) and need to know which design decisions are load-bearing and why.
**Do NOT use it for**: component inventory (`docs/architecture.md` is the doc of record), debugging a live failure (`intercom-debugging-playbook`), or audio/protocol theory (`telephony-audio-reference`).

## The system in one paragraph

A single Node.js process on a Raspberry Pi serves HTTP and WebSocket on one port (default 8080), exposed through one Cloudflare Tunnel hostname. An intercom PSTN call hits a Twilio number; Twilio POSTs `/twiml`, gets back `<Connect><Stream>` pointing at `wss://{TUNNEL_HOSTNAME}/media`, and opens a bidirectional WebSocket carrying base64 mu-law audio. The server rings a HAP-NodeJS video-doorbell accessory; when the user opens the live view, two ffmpeg processes bridge audio both ways over SRTP. A HomeKit lock tile sends DTMF over the same WebSocket to buzz the door.

## Load-bearing decisions and WHY

Each of these was arrived at the hard way. Do not undo one without reading its rationale and the referenced history.

| Decision                                                                         | Rationale                                                                                                                                                                                                                                                 | History                                                                |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Single process, single port                                                      | HTTP (TwiML) and WS (media) share port 8080 so one tunnel ingress rule and one stable public hostname cover everything.                                                                                                                                   | Original design; unchanged.                                            |
| Bidirectional `<Connect><Stream>` TwiML (not `<Start><Stream>` + `<Play>`)       | `<Connect>` holds the call open AND lets the server send media (ringback, DTMF) back over the same WebSocket. The old `<Start>`+`<Play loop="0">` design streamed one-way and held the call with a fetched ringtone URL.                                  | Replaced during the 2026-05-03 call-flow overhaul (PR #21, `fce3853`). |
| Stream token travels as TwiML `<Parameter>`, arrives in `start.customParameters` | The original WS-URL-query approach was replaced (the commit records no rationale, but the change was titled a fix — treat query-string tokens as a known-bad path). Auth therefore happens at the `start` event, not at WS accept.                        | `bf7aa2f` "Fix Twilio media stream token handling".                    |
| Synthetic black H.264 video                                                      | HomeKit refuses a doorbell camera without a video track; there is no physical camera. ffmpeg `lavfi color=black` generates it.                                                                                                                            | Original design.                                                       |
| Opus (16 kHz) audio codec, not AAC-ELD                                           | libopus ships in every standard ffmpeg build; AAC-ELD needs a custom ffmpeg compile (`--enable-libfdk-aac --enable-nonfree`).                                                                                                                             | Comment in `homekit.js` inbound-ffmpeg block.                          |
| Avahi mDNS advertiser (`hap.MDNSAdvertiser.AVAHI`)                               | Commit records no rationale; Avahi is the system mDNS daemon on Raspberry Pi OS. Do not switch advertisers without re-testing pairing and discovery.                                                                                                      | `9724241` "switch to avahi".                                           |
| Unlock DTMF generated in-process and sent over the media WebSocket               | The project flip-flopped: REST-API DTMF was restored (`e4587cd`) then abandoned again for stream-sent DTMF (`4292bc2`), because with `<Connect><Stream>` the WebSocket IS the call — media sent over it reaches the caller without disturbing the stream. | `e4587cd` → `4292bc2` (final state).                                   |
| Ringback/ringtone generated in pure JS, no ffmpeg at startup                     | The WAV was originally rendered by ffmpeg at boot; the identical mu-law cycle already existed in JS, so `/ringtone` now serves a PCM16 WAV rendered from it — no startup ffmpeg job, no `/tmp` file.                                                      | `c7d7ab1` (PR #35).                                                    |
| Inline HTTP route map, no framework                                              | Only four GET routes plus `/twiml` exist; the previous `httpdispatcher` dependency was unmaintained and silently mishandled `.wav` paths.                                                                                                                 | `afd1d04` (the `.wav` bug), removal in `c7d7ab1`.                      |
| Process exits on `uncaughtException`/`unhandledRejection`                        | A long-running bridge in an undefined state is worse than a 5-second outage; systemd (`Restart=on-failure`, `RestartSec=5`) restarts it.                                                                                                                  | `5b02700` (PR #30).                                                    |

## Invariants — these must hold after any change

1. **At most one active call.** `src/core/state.js` `startCall()` rejects a second concurrent callSid (`reason: 'another call is already active'`). Mid-call operations resolve the call via `state.getActiveCall()`.
2. **Every media WebSocket must authenticate within 5 s.** A one-time HMAC token (TTL 90 s, nonce consumed on use, bound to the issuing callSid) must arrive in `start.customParameters.token`; `STREAM_START_TIMEOUT_MS = 5000` in `server.js` closes connections that never send a valid `start`.
3. **Three-layer auth chain, no exceptions:** `/twiml` → Twilio signature (`X-Twilio-Signature` validated against `TWILIO_WEBHOOK_BASE_URL`); `/media` → Twilio signature on the handshake (before `accept()`, mode set by `TWILIO_MEDIA_SIGNATURE_MODE`) **then** the one-time stream token; `/status` → bearer token compared with constant-time `safeEqualString`. Only `/healthz`, `/readyz`, `/ringtone` are deliberately public. The handshake signature is defence in depth only: it has no body or query string, so it is an HMAC over a constant URL and is identical on every call. The one-time token remains the sole single-use control on `/media` and must never be removed in favour of it.
4. **Audio is forwarded to HomeKit only while a live view is open** (`hasHomekitSession` in `src/core/media-stream.js`). Buffering pre-answer audio creates seconds of catch-up latency.
5. **Backpressure drops frames, never queues.** When the mulaw PassThrough needs draining, frames are dropped and logged (`media-frames-dropped`). Unbounded queueing behind a stalled ffmpeg was the failure mode fixed in PR #30.
6. **Audio PTS derives from sample count, never wall clock.** Wall-clock timestamps break when ffmpeg drains the buffered startup burst (`57f3171`; comment above the inbound ffmpeg spawn in `homekit.js`).
7. **SSRC values are masked to a positive signed 32-bit range** (`& 0x7fffffff`) because ffmpeg parses `-ssrc` as a signed int (`b93af64`).
8. **The video stream must emit an IDR frame every second** (`-g`/`-keyint_min` at the fps). Without it the HomeKit tile stays blank until the next natural keyframe.
9. **All runtime logging goes through `src/core/log.js`** with `message` + `event` fields; never `console.*` (AGENTS.md rule — the README's log examples must byte-match emissions).
10. **CommonJS everywhere; tests are `.cjs`** (AGENTS.md rule).
11. **Config is validated at require time and the process refuses to start on invalid env** (`src/core/config.js` throws `[config] …`). A crash-looping service with `[config]` in the journal means bad env, not a code bug.

## Known weak points (open, stated plainly)

- **Two-way audio is intermittently flaky** (maintainer-confirmed, 2026-07-04). This is the project's hardest live problem — see `intercom-two-way-audio-campaign` before attempting fixes.
- **In-memory nonce store**: tokens issued before a restart are invalid after it, so a call that arrives mid-restart fails token verification once. Accepted trade-off; no persistence layer.
- **Single-call design**: a second simultaneous caller is rejected by design; there is no queueing.
- **SDP files written to `/tmp`** (`/tmp/intercom_return_<sessionID>.sdp`), unlinked on session stop; a crash can leave strays.
- **No real camera**: the video track is synthetic; "video broken" reports are usually keyframe/SRTP issues, not camera issues.

## Configuration axes

`.env.example` is the source of truth for every variable, defaults, and inline docs. What it cannot tell you: validation rules live in `src/core/config.js` (regexes for SID/E.164/MAC/pincode, minimum secret lengths 32/16), and `streamAuthTtlSec = 90` is **hardcoded** there, not an env var. Adding a variable requires updating `.env.example` in the same PR (AGENTS.md docs-sync rule).

## Provenance and maintenance

Written 2026-07-04 against commit `d377b02`. Re-verify volatile claims:

- Invariant enforcement points: `grep -n "another call is already active" src/core/state.js` · `grep -n "STREAM_START_TIMEOUT_MS" server.js` · `grep -n "0x7fffffff" homekit.js` · `grep -n "keyint_min" homekit.js`
- Hardcoded token TTL: `grep -n "streamAuthTtlSec" src/core/config.js`
- Auth chain endpoints: `grep -n "GET_ROUTES.set\|isValidTwilioRequest\|isAuthorizedForStatus" server.js`
- History references: `git log --oneline | grep -iE "avahi|token handling|httpdispatcher|teardown"`
