---
name: intercom-change-control-and-docs
description: How changes land in this repo — branch naming, conventional commits, the five quality gates, docs-sync obligations, and release automation — with the rationale behind each rule. Use before committing, opening a PR, or editing README.md, docs/, AGENTS.md, or .env.example. AGENTS.md is the doc of record; this skill operationalises it as a checklist.
---

# Change control and docs discipline

**Use this skill when** you are about to commit, open a PR, or touch any documentation file.
**Do NOT use it for**: deciding how to test a change (`intercom-testing-and-validation`) or writing runtime code patterns (AGENTS.md covers module format and logging directly).

`AGENTS.md` at the repo root is the doc of record for all of this. This skill turns it into an executable checklist and adds the WHY. If they ever disagree, AGENTS.md wins — fix this skill.

## Non-negotiables and why

| Rule                                                                       | Rationale                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never commit directly to `main`                                            | Releases are cut from `main` by release-please; every change must arrive reviewed via PR.                                                                                                                                                                                                                                                                                              |
| Conventional commits, allowed types `feat fix refactor test docs chore ci` | release-please derives version bumps and the changelog from commit types (`feat` → minor, `fix` → patch). Format is enforced by commitlint (CI + husky `commit-msg` hook); the seven-type restriction is AGENTS.md doctrine, enforced on PR titles by the `pr-title` workflow (commitlint's `config-conventional` alone would also accept e.g. `perf`, `style` — don't use them here). |
| PR titles use the same conventional format                                 | On squash-merge the title becomes the commit on `main` that release-please reads. Enforced by the `pr-title` workflow.                                                                                                                                                                                                                                                                 |
| One logical change per commit                                              | So it can be reviewed and reverted independently — the 2026-05-03 session relied on clean reverts (`c6f91a1`, `c98ba40`).                                                                                                                                                                                                                                                              |
| CommonJS only; tests are `.cjs`; JSDoc types; structured logger only       | AGENTS.md rules; the typecheck gate (`tsc --noEmit`) depends on the JSDoc discipline.                                                                                                                                                                                                                                                                                                  |
| Docs updated in the SAME PR as the change                                  | Docs drift is treated as a CI-visible defect; the sync rules below are specific and mechanical.                                                                                                                                                                                                                                                                                        |

## Pre-PR checklist (run every time)

```bash
# 1. Branch: <type>/<short-description>, e.g. fix/outbound-audio-pt
git checkout -b fix/my-change

# 2. All five quality gates (npm install first if node_modules is absent)
npm run typecheck && npm run lint && npm run format:check && npm run check && npm run test

# 3. Docs-sync grep — search docs for every name your change touches
grep -rn "myModuleName\|my-env-var\|my-log-message" README.md docs/ AGENTS.md .env.example
```

`npm run format` applies Prettier fixes in place if `format:check` fails.

## Docs-sync rules (mechanical, from AGENTS.md)

| You changed…                                     | You must update…                                                                                                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `logger.*` call whose output appears in README | The README end-to-end test sequence — log examples must **byte-match** the emitted `message`, `component`, and field names. Verify: grep the `message` string in both places. |
| Added/removed a module or top-level file         | README file-structure tree AND `docs/architecture.md` runtime-components list                                                                                                 |
| An HTTP endpoint (route, auth, response shape)   | README endpoints table + test stages AND `docs/architecture.md` auth-boundaries section (which must list every endpoint, including intentionally unauthenticated ones)        |
| An env var                                       | `.env.example` (the single source of truth) with an inline comment                                                                                                            |
| A test file                                      | `docs/testing.md` test-layout list                                                                                                                                            |
| CI workflows, git hooks, release automation      | `docs/testing.md` CI-notes section                                                                                                                                            |

## Automation map

- **Local hooks (husky, installed by `npm install`)**: `commit-msg` runs commitlint; `pre-commit` runs lint-staged (ESLint + Prettier on staged files only).
- **CI on every PR** (`.github/workflows/ci.yml`): the five gates + `npm audit --audit-level=high`, on Node 20, 22, and 24; plus commitlint over branch commits (dependabot commits exempted) and the conventional-PR-title check.
- **Releases** (`.github/workflows/release-please.yml`): release-please maintains a release PR on `main`; merging it tags a release. You never hand-edit versions or changelogs.
- **Pre-approved commands** for agents (`.claude/settings.json` allowlist): the five gates, `git status/diff/log/show/branch`, `gh pr view/checks/list`, `npx prettier --check`, `npx commitlint`.

## Discipline rules that live nowhere else

- **Don't spam the live Twilio number.** Hardware-in-the-loop verification dials a real phone number attached to a real household. Plan test calls so one call verifies several things; see `intercom-testing-and-validation`.
- **Keep changes hardware-agnostic.** Skills and docs describe any installation of this project, not one specific building's intercom behaviour.
- **A change that alters runtime behaviour needs a validation plan before the PR**, not after — state which README E2E stages it gates on (see `intercom-testing-and-validation`).

## Provenance and maintenance

Written 2026-07-04 against commit `d377b02`. Re-verify:

- Rules source: read `AGENTS.md` (short; always current by policy)
- Allowed commit types: AGENTS.md "Git workflow" section · `grep -n -A 8 "types:" .github/workflows/pr-title.yml` · dependabot exemption: `grep -n "ignores" commitlint.config.js`
- Gates list: `grep -n '"scripts"' -A 10 package.json`
- CI matrix and audit level: `grep -n "node-version\|audit-level" .github/workflows/ci.yml`
