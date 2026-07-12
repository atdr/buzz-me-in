---
name: cloudflared-tunnels
description: Verified facts and gotchas for Cloudflare Tunnel (cloudflared). Use when creating, configuring, or troubleshooting a tunnel, editing config.yml ingress rules, wiring Cloudflare Access to tunnel hostnames, installing cloudflared as a systemd service, or debugging tunnel 403/404/connection errors.
---

# Cloudflare Tunnel (cloudflared) working knowledge

Facts below were validated end to end in July 2026 with cloudflared 2026.7.1 on Debian 13. Prefer these over official docs where they conflict.

## Security-critical: `originRequest.access` placement

The `access` block makes cloudflared validate the Cloudflare Access JWT before forwarding to the origin. It only works **under each individual ingress rule**. At the top level of `config.yml` it is **silently ignored and traffic fails open** (unauthenticated requests are forwarded), despite what the docs imply about top-level `originRequest` settings. See cloudflared#784 and cloudflare-docs#32006.

```yaml
ingress:
  - hostname: host.example.com
    service: ssh://localhost:22
    originRequest:
      access: # must be HERE, per rule — never top-level
        required: true
        teamName: <team-name>
        audTag:
          - <access-app-audience-tag>
  - service: http_status:404
```

When adding or reviewing an Access-protected ingress rule, always verify enforcement empirically: a request with no Access token must be rejected by cloudflared itself.

## Ingress rules

- Rules match top to bottom; the last rule must be a catch-all (no `hostname`).
- A config with a single hostname-less rule is valid but forwards **every** hostname routed to the tunnel. Prefer explicit `hostname:` matches plus a `service: http_status:404` catch-all.
- `credentials-file` must be an absolute path. The tunnel UUID is in the `tunnel create` output, the credentials JSON filename, and `cloudflared tunnel info <name>`.
- Validate before running: `cloudflared tunnel ingress validate`; test which rule a URL hits: `cloudflared tunnel ingress rule <url>`.
- WebSockets work through the tunnel with no extra configuration.

## Running as a systemd service

- Use the built-in installer, not a hand-written unit:
  `sudo cloudflared --config ~/.cloudflared/config.yml service install`
  It copies the config to `/etc/cloudflared/config.yml`, writes a correct unit, and enables **and** starts it. After that, edit `/etc/cloudflared/config.yml` and `sudo systemctl restart cloudflared`.
- The explicit `--config` is required: under sudo, cloudflared searches root's config locations and will not find `~/.cloudflared/config.yml` (the shell expands `~` before sudo runs, so the command above works).
- Binary path depends on install method: apt repository → `/usr/bin/cloudflared`; manual download → `/usr/local/bin/cloudflared`. A unit file pointing at the wrong one fails with `status=203/EXEC`.
- Install via the Cloudflare apt repository (pkg.cloudflare.com) so `apt upgrade` keeps it current.
- Always test in the foreground first (`cloudflared tunnel run <name>`, look for `Registered tunnel connection` lines) before installing the service.

## Access applications (Zero Trust / Cloudflare One)

- Create the Access application **before** routing DNS to the tunnel, so the hostname is protected from the moment it resolves. Any hostname the tunnel exposes without an Access destination is reachable by the whole internet.
- Free tier limits: only one level of subdomain (edge cert limitation), up to five destinations per application.
- The Application Audience (AUD) tag lives in the application's **Additional settings** tab; it's needed for the per-rule `access` block.
- Default session duration is 24 hours.

## Debugging

- Bare `403` shortly after setup: the Access app hasn't propagated to the edge yet and the per-rule `access` block is rejecting the request itself (defence in depth working).
- `404`: the hostname fell through to the catch-all rule — check that `hostname:` values in config.yml match the `tunnel route dns` entries exactly.
- `cloudflared tunnel info <name>` shows the UUID and active connectors.

## SSH through a tunnel

Client side, in `~/.ssh/config`:

```
Host host.example.com
  ProxyCommand cloudflared access ssh --hostname %h
```

`cloudflared access ssh-config --hostname <host>` prints this block with the absolute binary path filled in. Use the absolute path if cloudflared isn't on `$PATH` when SSH spawns the ProxyCommand.

## Secrets

`~/.cloudflared/cert.pem` and the tunnel credentials `<uuid>.json` are secrets: `chmod 600`, never commit, and keep them out of rsync/deploy payloads.

## Provenance and maintenance

Written 2026-07-12 from an end-to-end setup on Debian 13 with cloudflared 2026.7.1; citations re-checked 2026-07-12. Re-verify:

- `access` placement claim: [cloudflared#784](https://github.com/cloudflare/cloudflared/issues/784) · [cloudflare-docs#32006](https://github.com/cloudflare/cloudflare-docs/issues/32006) · empirically, a request to the protected hostname with no Access token must be rejected before reaching the origin
- Ingress semantics: `cloudflared tunnel ingress validate` · `cloudflared tunnel ingress rule <url>`
- Service install behaviour: after install, `systemctl cat cloudflared` · `ls /etc/cloudflared/`
- Version drift: `cloudflared --version`; re-test the `access` placement claim after major cloudflared upgrades in case upstream fixes #784
