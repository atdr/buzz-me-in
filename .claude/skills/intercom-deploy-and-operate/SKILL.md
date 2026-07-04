---
name: intercom-deploy-and-operate
description: Operating the production Raspberry Pi — systemd units, cloudflared tunnel, Twilio console wiring, journalctl log access, health/status probes, the rsync deploy loop, and outage discrimination (tunnel down vs server down vs config crash-loop). Use when deploying a change, recovering a down service, or recreating the environment from scratch. Setup steps live in README (doc of record); this skill adds the operational commands and known traps.
---

# Deploy and operate

**Use this skill when** you ship code to the Pi, the service is down, or you're rebuilding the environment.
**Do NOT use it for**: diagnosing call-flow bugs once the service is up (`intercom-debugging-playbook`), or local development (`intercom-testing-and-validation`).

README's Setup section (steps 1–6) is the doc of record for from-scratch installation. This skill assumes it exists and adds what README doesn't: day-2 operations.

## The deployment model

Two systemd units, journald logging, `.env` file for config:

- `intercom.service` — `node server.js`, `User=pi`, `WorkingDirectory=/home/pi/intercom`, `EnvironmentFile=/home/pi/intercom/.env`. `Restart=on-failure` with `RestartSec=5`: crashes restart in ~5 s, **clean exits stay down** (intentional, so a deliberate stop sticks). Ordered `After=cloudflared.service`.
- `cloudflared.service` — `cloudflared tunnel run intercom`, reading `~/.cloudflared/config.yml`.

The server exits deliberately on `uncaughtException`/`unhandledRejection` and relies on systemd to restart it — a restart in the journal is the designed recovery path, not necessarily a bug to chase (but grep the exception first).

### Known trap: cloudflared binary path

`cloudflared.service` hardcodes `ExecStart=/usr/local/bin/cloudflared`, but installing via the Cloudflare **apt repository** (the README-recommended route) puts the binary at `/usr/bin/cloudflared`. If the tunnel unit fails with status 203/EXEC, run `which cloudflared` and align the unit's `ExecStart`.

## Ship a change

```bash
# From the repo checkout, after the five gates pass and the PR merged:
rsync -av --exclude node_modules --exclude .env ./ pi@raspberrypi.local:~/intercom/
ssh pi@raspberrypi.local 'cd ~/intercom && npm install && sudo systemctl restart intercom'

# Confirm:
ssh pi@raspberrypi.local 'systemctl is-active intercom cloudflared'
curl https://$TUNNEL_HOSTNAME/healthz   # expect {"ok":true}
```

After any deploy that touched the call path, run the relevant README E2E stages (see `intercom-testing-and-validation` for the mapping) — one planned test call.

## Operational field guide

```bash
# Live logs (JSON lines):
journalctl -u intercom -f -o cat
journalctl -u cloudflared -f -o cat

# Everything since last boot:
journalctl -u intercom -b -o cat

# Is a call active right now?
curl -H "Authorization: Bearer $STATUS_API_TOKEN" https://$TUNNEL_HOSTNAME/status
# → {"active":false} or {"active":true,"callSid":"CA…"}

# Service control:
sudo systemctl restart intercom          # safe when no call active (check /status first)
sudo systemctl status intercom cloudflared
```

Notes:

- **Restarting drops the in-memory nonce store** — a caller who dialed during the restart window gets one failed connection (token verification fails). Check `/status` before restarting.
- **Stale sessions self-heal**: a dead call's slot is reaped after `CALL_SESSION_STALE_SEC` (default 900 s). Restarting clears it immediately.
- HAP pairing data persists (HAP-NodeJS storage) — restarts do NOT require re-pairing. Changing `HAP_USERNAME` effectively creates a new accessory and DOES require re-pairing.

## Outage discrimination (fastest split first)

| Test                                                                     | Result | Conclusion                                                                                                                           |
| ------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| On the Pi: `curl localhost:8080/healthz`                                 | fails  | Server down → `journalctl -u intercom -b -o cat`, look for `[config]` (bad env → crash-loop), `uncaught-exception`, or port conflict |
| Server OK locally, `curl https://$TUNNEL_HOSTNAME/healthz` from anywhere | fails  | Tunnel down → `journalctl -u cloudflared`, check the binary-path trap above, `cloudflared tunnel info intercom`                      |
| Both OK but calls don't arrive                                           | —      | Twilio side → console → Phone Numbers → Voice webhook must be `https://{host}/twiml`, POST; check Twilio call log for webhook errors |
| Calls arrive but misbehave                                               | —      | → `intercom-debugging-playbook`                                                                                                      |

## From-scratch rebuild checklist (delta over README)

README steps 1–6 are complete and current. Additional hard-won specifics:

- ffmpeg must have **both** libx264 and libopus: `ffmpeg -codecs | grep -E "libx264|libopus"` — the stock `apt install ffmpeg` on Raspberry Pi OS includes both.
- `HAP_PORT` (default 47129) and mDNS (UDP 5353, Avahi) must be reachable from the iPhone's LAN — HomeKit discovery is LAN-multicast; the tunnel plays no part in HomeKit traffic.
- Generate `HAP_USERNAME` and `HAP_PINCODE` with the one-liners in `.env.example` comments; both are format-validated at startup.
- systemd unit paths assume `/home/pi/intercom` — edit `WorkingDirectory`/`EnvironmentFile`/`User` if different.

## Provenance and maintenance

Written 2026-07-04 against commit `d377b02`. Re-verify:

- Unit directives: `grep -n "ExecStart\|Restart\|EnvironmentFile\|After=" intercom.service cloudflared.service`
- Deploy loop: README "Deploying updates" section (doc of record)
- Probe endpoints and auth: `grep -n "GET_ROUTES.set" server.js`
- Stale/restart behaviour: `grep -n "CALL_SESSION_STALE_SEC" .env.example` · `grep -n "process.exit" server.js`
