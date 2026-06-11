# Architecture

This document focuses on stable architecture concepts. It intentionally avoids transient implementation details so it stays useful as internals evolve.

## Runtime components

- `server.js`
  - HTTP entrypoint for TwiML + health/status routes
  - WebSocket entrypoint for Twilio media streams
  - call/session orchestration across modules
- `homekit.js`
  - HomeKit accessory lifecycle and two-way media bridge
  - ffmpeg process orchestration for inbound/outbound audio paths
- `twilio-api.js`
  - Twilio REST helper for hanging up a call
- `src/core/media-stream.js`
  - per-connection Twilio media stream protocol handling (start/media/stop, token check, ringback, teardown) with injected state/HomeKit/logging dependencies
- `src/core/state.js`
  - in-memory call session management and stale-session reaping
- `src/core/stream-auth.js`
  - HMAC-signed one-time stream token issue and verify
- `src/core/mulaw-audio.js`
  - mu-law audio generation: DTMF tones, ringback cycle, chunked send helpers
- `src/core/ws-events-schema.js`
  - Twilio WebSocket envelope validation and media payload parsing
- `src/core/safe-equal.js`
  - constant-time string comparison shared by auth checks
- `src/core/config.js`
  - validated environment/config loading
- `src/core/log.js`
  - lightweight structured logging (JSON lines)

## Request and media flow

1. Twilio sends webhook request to `POST /twiml`.
2. `server.js` validates Twilio signature and returns TwiML with signed bidirectional WS stream token.
3. Twilio opens WebSocket stream on `/media`. The signed token is passed as a TwiML `<Parameter>` and arrives in the `start` event's `customParameters`.
4. Server validates/consumes one-time token and processes WS events (`connected/start/media/stop`).
5. On `start`, server initializes call state and connects Twilio mulaw stream to HomeKit pipeline.
6. HomeKit sessions use ffmpeg to:
   - ingest Twilio inbound mulaw and forward media to HomeKit SRTP
   - ingest HomeKit return audio and forward mulaw payloads back to Twilio WS
   - send generated ringback and unlock DTMF back to Twilio over the same WS
7. Call/session cleanup occurs on Twilio `stop`, WS close, stale timeout, or shutdown.

## Session model

Session state is managed by `src/core/state.js`:

- one active call at a time
- session stores `callSid`, `streamSid`, websocket connection, timestamps, last activity
- stale reaper clears inactive sessions and triggers cleanup callback
- explicit clear paths:
  - by active call
  - by websocket connection
  - by stale timeout

## Token and auth boundaries

- TwiML webhook auth:
  - Twilio signature validation on `POST /twiml`
- Media stream auth:
  - short-lived HMAC-signed stream tokens
  - one-time nonce consumption to prevent replay
- Status endpoint auth:
  - bearer token validation for `GET /status`
- Intentionally unauthenticated:
  - `GET /healthz` and `GET /readyz` (liveness/readiness probes, return only `{"ok":true}`)
  - `GET /ringtone` (debug WAV)

## Logging model

Structured logs are emitted as JSON lines with canonical operational fields:

- `component`
- `callSid`
- `event`
- `reason`
- `durationMs` (for lifecycle timing)

Log routing:

- `debug`/`info` → stdout
- `warn`/`error` → stderr
