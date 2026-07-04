---
name: intercom-testing-and-validation
description: What counts as evidence in this repo — the five quality gates, unit-test patterns and isolation pitfalls (env leakage, module cache, reaper timers), and how the 10-stage hardware-in-the-loop E2E sequence maps to code changes. Use when adding or changing tests, when tests fail mysteriously, or when deciding how a change must be validated before a PR. For the commit/PR mechanics use intercom-change-control-and-docs.
---

# Testing and validation

**Use this skill when** you write or debug tests, or need to decide what proof a change requires.
**Do NOT use it for**: PR mechanics (`intercom-change-control-and-docs`), triaging production failures (`intercom-debugging-playbook`).

`docs/testing.md` is the doc of record for commands, test layout, and isolation pitfalls. This skill adds the evidence hierarchy, the stage→change mapping, and the live-number discipline.

## Evidence hierarchy

1. **Five gates** (`typecheck`, `lint`, `format:check`, `check`, `test`) — necessary for every PR, sufficient for nothing behavioural.
2. **Unit tests** (`node --test`, files in `tests/*.test.cjs`) — sufficient for boundary parsers, token logic, session state, audio generation.
3. **Hardware-in-the-loop E2E** (README "End-to-end test sequence", Stages 1–10) — the only sufficient evidence for anything touching the live call path (ffmpeg args, TwiML, WS protocol handling, HAP streaming). Success is defined by the exact log events listed per stage, **never by ear or by eye**.

## Which changes need which E2E stages

| Change touches…                                    | Minimum stages to re-run                                |
| -------------------------------------------------- | ------------------------------------------------------- |
| Config loading, logging, docs only                 | None (gates + unit tests)                               |
| HTTP routes / auth (`server.js`, `stream-auth.js`) | 1–2, plus 4 if the media path is affected               |
| TwiML / WS protocol (`media-stream.js`, schema)    | 4 (inbound call) and 8 (caller hang-up)                 |
| Inbound audio/video pipeline (`homekit.js` ffIn)   | 5 (live view)                                           |
| Outbound audio pipeline (ffOut, SDP)               | 6 (two-way audio) — see intercom-two-way-audio-campaign |
| DTMF / unlock                                      | 7 (unlock)                                              |
| Teardown / lifecycle / systemd                     | 8, 9, 10 (hang-ups and reboot)                          |

## The live-number rule

E2E stages 4–9 dial a **real Twilio number attached to a real household**. Test calls cost money and ring devices people live with.

- Plan before dialing: list every gate/observation the call must produce, then make **one** call and capture the full journal (`journalctl -u intercom --since "5 min ago" -o cat > /tmp/call-evidence.jsonl`).
- Never script repeated automatic calls at the live number.
- Anything verifiable locally (Stage 1 health checks, unit tests, `ffmpeg -codecs`) must be verified locally first.

## Unit test patterns (the parts that bite)

- **Run**: `npm run test` (sets `DOTENV_CONFIG_PATH=/dev/null` so your local `.env` cannot leak). Single file: `DOTENV_CONFIG_PATH=/dev/null node --test tests/state.test.cjs`.
- **Env isolation**: use `applyEnv` / `withEnv` from `tests/helpers/env.cjs` — they restore previous values in teardown. Never mutate `process.env` bare.
- **Module cache**: `config` and `state` are require-time singletons. Tests needing different env must reload via `freshRequire` (also in `helpers/env.cjs`).
- **Timers**: `state` starts a stale-reaper `setInterval`; call `.stop()` on manager instances in teardown or tests will interfere across files. Simulate time explicitly (the stale-session tests show how) — no real waiting.
- **Fakes over mocks**: `MediaStream` takes an injected `MediaStreamDeps` object (state, homekit, logger, token verifier) precisely so protocol tests run with plain fakes — follow `tests/media-stream.test.cjs`.
- Cover **both success and rejection paths** for anything that parses or validates boundary input (see `tests/ws-events-schema.test.cjs`, `tests/stream-auth.test.cjs` for the pattern: replay, tamper, expiry, malformed).

## CI reality

CI (`.github/workflows/ci.yml`) runs the five gates plus `npm audit --audit-level=high` on Node 20, 22, and 24. A change that passes locally but fails CI: first suspect Node version differences, then a dirty working tree (`git status`), then a transitive-dependency audit failure (see the archaeology in `intercom-debugging-playbook` — audit failures recur and are fixed with targeted bumps/overrides).

## Provenance and maintenance

Written 2026-07-04 against commit `d377b02`. Re-verify:

- Commands and pitfalls: read `docs/testing.md` (doc of record)
- Test-runner env guard: `grep -n "DOTENV_CONFIG_PATH" package.json src/core/config.js docs/testing.md`
- Helper API: `grep -n "module.exports" tests/helpers/env.cjs`
- Stage definitions: README "End-to-end test sequence" section
