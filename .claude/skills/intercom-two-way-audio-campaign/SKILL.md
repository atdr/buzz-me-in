---
name: intercom-two-way-audio-campaign
description: Decision-gated diagnostic and fix campaign for the project's hardest OPEN problem — intermittent two-way audio failure (no/one-way/garbled/dropping audio during a HomeKit live view; the open remainder is the caller → iPhone leg at session startup, #102). Use when audio misbehaves during a call and the quick triage in intercom-debugging-playbook points here. Follow the gates in order; success is measured in log events and captured packets, never judged by ear.
---

# Campaign: intermittent two-way audio

**Status: OPEN, narrowed** (updated 2026-09-27). On iOS 26 the maintainer reports audio working reliably in both directions, apart from niggles at session startup. The 2026-05-03 session (PR #21, 12 commits, 2 reverts) fixed the deterministic causes. What remains is tracked in #102 and was localised on 2026-09-27 to the **Pi → iPhone** leg (caller's voice): ffIn is silent for ~3 s after `mulaw-stream-bound`, then dumps ~4 s of audio in one second, then delivers in clumps with 80–183 ms gaps. Twilio → Pi, iPhone → Pi, and Pi → Twilio were all measured clean in the same calls.

**Use this skill when** two-way audio fails or degrades and you intend to diagnose or fix it.
**Do NOT use it for**: first-pass triage of any call problem (`intercom-debugging-playbook` first), protocol background (`telephony-audio-reference`).

## Ground rules

1. **Measure, don't listen.** Every gate below defines pass/fail as a log event, a file, or a packet capture. "Sounded fine" is not evidence; intermittent bugs demand artifacts you can diff between a good call and a bad one.
2. **One call, many observations.** The test number is a live household line (see the live-number rule in `intercom-testing-and-validation`). Before dialing, set up ALL captures below so a single call exercises every gate.
3. **All fixes route through change control** (`intercom-change-control-and-docs`): branch, gates, PR. No hotfixing on the Pi.

## Phase 0a — rule out the test rig

Before suspecting the server, make sure the far end of the test call is independent of the iPhone running the Home app. On 2026-09-27 (iOS 27) every test call went silent in both directions the moment the live view opened, and the unlock tone never arrived. The cause was the rig: the call was answered on a MacBook, which does not place mobile calls itself but relays them through the same iPhone over Continuity. Opening a live view with two-way audio takes the iPhone's audio session, and the relayed call loses its audio and eventually drops. The same rig had worked on iOS 26. A Twilio self-test call (recipe in `intercom-testing-and-validation`) avoids this with only one phone.

Signature of this false alarm: Twilio → Pi audio goes flat (constant digital silence) at the instant the live view opens, while the Pi's outbound frames (return audio, DTMF) are measurably non-silent. Without per-hop measurement it is indistinguishable from a server bug, which is why Phase 0 below matters.

## Phase 0 — instrument before the call

**Per-hop audio probe.** The strongest single instrument used so far is a temporary tap at four points: Twilio in (`MediaStream` media handler), ffIn stdin, ffOut stdout, and Twilio out (`sendMulawAudio`). Each point logs per-second frame counts plus mu-law loudness (RMS, peak, percentage of samples above about -30 dBFS) and appends the raw mu-law to a file. It was built for #102 on an unpushed branch and gated behind `AUDIO_PROBE=1`. It separates "no frames" from "frames of silence" from "speech", at every hop, in one call. Rebuild it rather than guessing, and never leave it enabled: it writes household call audio to disk.

```bash
# On the Pi, in three shells (or tmux panes), BEFORE dialing:
journalctl -u intercom -f -o cat > /tmp/call-$(date +%s).jsonl     # full journal
ls /tmp/intercom_return_*.sdp                                       # baseline: should be empty
# The return-audio UDP port is per-session; refine the filter at Gate 3:
sudo tcpdump -i any -n "udp" -c 200 -w /tmp/return-audio.pcap
```

Capture on `-i any`, not a named interface: the controller sends return SRTP to the address from `getLocalIp()` (a LAN address), so packets may arrive on `eth0`/`wlan0` rather than `lo`. Interface choice must never be the reason you conclude "no packets".

Reproduce: dial the Twilio number from a phone, answer the doorbell notification, open the live view, speak into the iPhone mic, then hang up from the iPhone.

**Keep good-call baselines.** When a call passes all gates, save its journal + pcap + SDP as the reference bundle (e.g. `/home/pi/call-baselines/<date>/`). Intermittent bugs are diagnosed by diffing a bad call's artifacts against a known-good set — without a baseline every bad call is uninterpretable.

## Gates — walk in order; branch at the first failure

### Gate 1 — call and stream established

**Expect** (journal): `twiml-response` → `media-ws-accepted` → info-level `start` → `doorbell-triggered`.
**If missing** → this is not an audio problem; go to `intercom-debugging-playbook` (token, tunnel, signature rows).

### Gate 2 — inbound path (caller → iPhone)

**Expect** after opening the live view:

- `ringback-stopped` with reason `homekit-session-started`
- `mulaw-stream-bound` (homekit)
- NO early `ffin-exit`; `ffin-stderr` free of `libx264`/`libopus` errors
- No sustained `media-frames-dropped` (a brief drop at open is tolerable; continuous dropping is a stall)

**Branches:**

- `mulaw-stream-bound` absent → the PassThrough never attached: inspect `attachMulawStreamToSession` preconditions in `homekit.js` (destroyed stream? ffIn stdin gone?). The rebind path (`mulaw-stream-rebound`) covers a call that starts while a live view is already open.
- `ffin-stderr` codec errors → `ffmpeg -codecs | grep -E "libx264|libopus"` on the Pi.
- **Known startup behaviour (#102), not a new fault:** ffIn emits nothing for ~3 s after `mulaw-stream-bound`, then ~200 packets (≈4 s of audio) in the first second. The iPhone appears to discard the burst, so the caller's first words after the live view opens are lost. Ringback stops at the start of that window, which is exactly when a caller would start speaking. Since #95 there is no cross-session backlog, so the burst is ffmpeg startup, not queued audio.
- Continuous `media-frames-dropped` → ffIn stdin is not consuming; capture `ffin-stderr` and check CPU (`top`) — an overloaded Pi stalls x264 encoding first (`-preset ultrafast` is already set).

### Gate 3 — outbound path, controller → server (the historically cursed half)

Find the session's return-audio parameters:

```bash
SDP=$(ls -t /tmp/intercom_return_*.sdp | head -1); cat "$SDP"
# m=audio <PORT> RTP/SAVP <PT>   ← note PORT and PT
sudo tcpdump -i any -n "udp port <PORT>" -c 10 -X
```

**Expect**: RTP packets flowing while you speak into the iPhone; byte 1 of each packet `& 0x7F` equals the `<PT>` from the SDP (README Stage 6 documents this check).

**Branches:**

- **No SDP file** → START never reached `_startSession`; check `stream-prepare-failed` and HAP negotiation in the journal.
- **No packets** → the controller isn't sending, or they're arriving on a different interface/port: re-run tcpdump without the port filter; verify the iPhone mic is unmuted in the live view; check `prepareStream` returned the right address (`getLocalIp()` picks the first non-internal IPv4 — multi-homed Pis can advertise the wrong interface: **known candidate cause**).
- **RTP clock is not a mismatch to chase here.** The controller clocks its Opus RTP timestamps at the negotiated sample rate (320 ticks per 20 ms at 16 kHz), while the return SDP declares `opus/48000/2` and the Pi's own outbound Opus uses 48 kHz (960 ticks). Verified 2026-09-27: ffOut decodes the controller's audio correctly regardless. Whether the controller minds the Pi's 48 kHz clock is open in #102.
- **PT mismatch** → HAP-NodeJS negotiation vs actual RTP out of sync — historically a HAP version incompatibility (the PT-110 assumption bug class). Check `npm ls hap-nodejs` against the version pinned in package.json and recent HAP-NodeJS changelogs.
- **Packets flow but `ffout-stderr` shows SRTP/decrypt errors** → key alignment regression (settled once in `5a235b7`; the return path must echo the controller's audio key+salt).

### Gate 4 — outbound path, server → Twilio

**Expect**: no early `ffout-exit`; and mu-law frames leaving over the WebSocket. There is deliberately no per-frame log; infer from the stale-reaper's activity tracking or add a **temporary debug counter** in the `ffOut.stdout.on('data', …)` handler in `homekit.js` (remove before PR).

**Branches:**

- `ffout-exit` immediately after start → ffmpeg rejected the SDP (`ffout-stderr` has the reason; `-protocol_whitelist file,crypto,udp,rtp` must cover every scheme used).
- Frames sent but caller hears nothing/garbage → Twilio side: verify chunks are raw mu-law 8 kHz (the envelope in `sendMulawAudio` does no transcoding) and check the Twilio console call log for stream warnings.

## Solution menu (ranked; each with its obligation)

1. **Interface selection fix** — if Gate 3 shows the wrong advertised address on a multi-homed Pi: make the return address configurable or derive it from the HAP socket. Obligation: reproduce the wrong-IP case in the journal first.
2. **HAP-NodeJS version bisect** — if PT/negotiation mismatches recur: bisect hap-nodejs versions (currently `^0.14.2`). Obligation: a captured PT mismatch (SDP vs tcpdump) on the bad version and its absence on the good one.
3. **ffout latency flags tuning** — `-fflags +nobuffer -flush_packets 1` are already set; further flags (e.g. `probesize`, `analyzeduration`) may cut start delay. Obligation: measure time from live-view open to first stdout chunk, before vs after.
4. **⛔ FENCED: outbound frame pacing** — tried `79df86b`, reverted `c6f91a1` the same day. Twilio's tolerance for faster-than-realtime inbound media is **unverified** (open theory question). Do not retry without packet-level evidence that burstiness — not content — causes the failure, plus a written prediction of what pacing will change in the capture.
5. **⛔ FENCED: outbound queue bounding** — tried `7dd02c0`, reverted `c98ba40`. Same evidence obligation as 4.

## Promotion protocol (how a fix becomes real)

1. Evidence bundle for the diagnosis: journal + SDP + pcap from at least one bad call, showing the mechanism. One mechanism must explain **all** observations, including why good calls succeed.
2. Written prediction: "with the fix, capture X will show Y instead of Z."
3. Fix lands via PR with the five gates; unit tests for anything unit-testable.
4. Validation: **3 consecutive clean test calls** (planned, spaced — live-number rule) each passing Gates 1–4 with captures retained.
5. Update the failure-archaeology table in `intercom-debugging-playbook` (symptom → root cause → evidence → commit) and, if a fenced path is vindicated or retired, this skill's solution menu.

## Provenance and maintenance

Written 2026-07-04 against commit `d377b02`; status, Phase 0a, the probe, and the Gate 2/3 notes updated 2026-09-27 from hardware testing of #88/#89/#95/#96 (evidence in #102). Re-verify:

- Problem still open? Ask the maintainer; check `git log --oneline -20` for audio fixes since `d377b02`.
- Revert fences still apply: `git log --oneline | grep -i revert`
- ffmpeg args and SDP shape: `grep -n "nobuffer\|protocol_whitelist\|rtpmap" homekit.js`
- Local-IP selection: `grep -n "getLocalIp" homekit.js`
