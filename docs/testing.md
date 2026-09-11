# Testing guide

This project uses lightweight quality gates on plain JavaScript (CommonJS) with targeted unit tests.

## Quality commands

Run these from the repository root:

- `npm run typecheck` - TypeScript JS checking (`tsc --noEmit`)
- `npm run lint` - ESLint checks
- `npm run format:check` - Prettier formatting check
- `npm run check` - Node syntax check for runtime modules
- `npm run test` - Node test runner (`node --test`)

For local iteration:

- `npm run format` - apply formatting fixes

Recommended pre-PR sequence:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check
npm run test
```

## Test layout

- `tests/config.test.cjs` - configuration loading and validation behavior
- `tests/state.test.cjs` - call session lifecycle and stale-session cleanup
- `tests/stream-auth.test.cjs` - stream token issue/verify, replay and tamper rejection, TwiML builder, `/media` handshake signature verification (URL variants, forgery rejection, candidate-set pin)
- `tests/media-stream.test.cjs` - Twilio media stream protocol (start/media/stop, token checks, teardown)
- `tests/ws-events-schema.test.cjs` - Twilio WS envelope and media payload validation
- `tests/mulaw-audio.test.cjs` - mu-law encode/decode, DTMF and ringback generation, WAV rendering
- `tests/log.test.cjs` - structured logger output, levels, and error normalization
- `tests/twilio-ids.test.cjs` - Twilio identifier normalization
- `tests/return-audio-sdp.test.cjs` - return-audio SDP generation and teardown
- `tests/homekit-shutdown.test.cjs` - the shutdown path unpublishes and never destroys (pairing-loss guard)
- `tests/cli.test.cjs` - `--qr`/`--check`/`--help`/`--version`, plus the hap-nodejs and node-persist behaviours they rest on
- `tests/publish-release-workflow.test.cjs` - release publish workflow guards
- `tests/publish-prerelease-workflow.test.cjs` - prerelease publish workflow guards
- `tests/coverage.test.cjs` - coverage script scope, preload, Codecov job, and entry-point inertness guards
- `tests/helpers/env.cjs` - env/module-cache test helpers
- `tests/helpers/coverage-preload.cjs` - loads the entry points so coverage reports them

## When adding new tests

1. Prefer unit tests near existing module suites (`tests/*.test.cjs`).
2. Cover both success and rejection paths for boundary parsers/validators.
3. Keep tests deterministic:
   - avoid timer races
   - if needed, simulate time explicitly (as done in stale-session tests)

## Isolation pitfalls and patterns

### Environment variable isolation

Use helper wrappers from `tests/helpers/env.cjs` to set and restore env values for each test. Avoid mutating `process.env` globally without restoring it.

The `npm test` script sets `DOTENV_CONFIG_PATH=/dev/null` so that a developer's local `.env` file cannot leak values into the test environment. If you invoke `node --test` directly, set this variable yourself.

### Module cache invalidation

Modules like `config` and `state` are loaded once by Node. If a test depends on changed env values, reload modules with cache clearing via `freshRequire`.

### Long-lived timers/intervals

`state` creates a stale-session reaper interval. Tests must stop manager instances in teardown to avoid cross-test interference.

### Shared singleton state

The runtime exports singleton-style modules. Tests should avoid relying on test execution order and should always reset state or load fresh module instances.

## CI notes

CI runs all five gates (lint, format check, syntax check, typecheck, tests) on Node 20, 22, and 24. Pull requests additionally run commitlint over the branch commits and a conventional PR title check.

A separate `Dependency audit` job runs `npm audit --audit-level=high` twice. The blocking run adds `--omit=dev`, so only advisories reaching the deployed dependency tree fail CI; the second run covers the whole tree and is `continue-on-error`, surfacing build-tool advisories as a warning without blocking unrelated PRs. It is deliberately outside the quality-gate job — an audit result reflects the advisory database at a point in time rather than the diff under review, and while it ran first inside that job any advisory masked lint, tests, and typecheck. Dev-tree advisories are fixed by Dependabot security updates rather than by hand; a red audit check now means genuine production exposure.

A `Coverage report` job re-runs the suite under V8 instrumentation on Node 22 and uploads
`lcov.info` to Codecov, which supplies the README badge, per-PR comments, and history. It
is reporting, not a sixth gate: the Node matrix is what proves the suite passes. Codecov's
own status checks are set `informational` in `codecov.yml` so they can never block a
merge, and the upload step is `continue-on-error` because an outage there says nothing
about the change under review. The coverage run itself stays blocking. CI calls
`npm run coverage` rather than its own command line so local and CI measure the same
thing; `tests/coverage.test.cjs` guards that and the rest of the setup.

```bash
npm run coverage   # needs Node >= 22.5; writes lcov.info (gitignored)
```

Two details in that script are load-bearing. `--test-coverage-include` is pinned to the
`files` array in `package.json`, so the measurement is what ships rather than every file
V8 happened to load. And `--require ./tests/helpers/coverage-preload.cjs` loads
`server.js`, `homekit.js` and `twilio-api.js`, which no test requires: V8 reports
_nothing_ for an unloaded file rather than reporting it at 0%, so dropping the preload
would delete the three least-tested shipped modules from the report and raise the number.

That preload is only possible because both entry points are inert when required —
`server.js` starts from `main()` and `homekit.js` publishes from `start()`, both gated on
`require.main === module`. See the "Entry points are inert on require" section in
`AGENTS.md`; `tests/coverage.test.cjs` guards it.

Locally, husky hooks (installed automatically by `npm install`) run commitlint on each commit message and lint-staged (ESLint + Prettier on staged files) before each commit.

Releases are automated by release-please, which maintains a release PR on `main` derived from conventional commit history.

If a change passes locally but fails in CI, first verify Node version parity and rerun all commands from a clean working tree.
