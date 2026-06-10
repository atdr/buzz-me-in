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
- `tests/stream-auth.test.cjs` - stream token issue/verify, replay and tamper rejection, TwiML builder
- `tests/ws-events-schema.test.cjs` - Twilio WS envelope and media payload validation
- `tests/helpers/env.cjs` - env/module-cache test helpers

## When adding new tests

1. Prefer unit tests near existing module suites (`tests/*.test.cjs`).
2. Cover both success and rejection paths for boundary parsers/validators.
3. Keep tests deterministic:
   - avoid timer races
   - if needed, simulate time explicitly (as done in stale-session tests)

## Isolation pitfalls and patterns

### Environment variable isolation

Use helper wrappers from `tests/helpers/env.cjs` to set and restore env values for each test. Avoid mutating `process.env` globally without restoring it.

### Module cache invalidation

Modules like `config` and `state` are loaded once by Node. If a test depends on changed env values, reload modules with cache clearing via `freshRequire`.

### Long-lived timers/intervals

`state` creates a stale-session reaper interval. Tests must stop manager instances in teardown to avoid cross-test interference.

### Shared singleton state

The runtime exports singleton-style modules. Tests should avoid relying on test execution order and should always reset state or load fresh module instances.

## CI notes

CI runs all five gates (lint, format check, syntax check, typecheck, tests) on Node 20 and Node 22.

If a change passes locally but fails in CI, first verify Node version parity and rerun all commands from a clean working tree.
