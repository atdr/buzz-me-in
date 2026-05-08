# Agent guidance

This file provides guidance for AI agents working on this codebase.

## Architecture overview

Single-process Node.js server. `server.js` and `homekit.js` are the two top-level
runtime modules. Shared utilities live under `src/core/`. See `docs/architecture.md`
for the full component map and data flow.

## Quality gates

Run all five before opening a PR:

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint
npm run format:check # Prettier
npm run check        # node --check on runtime files
npm run test         # node --test
```

`npm run format` applies Prettier fixes in place.

## Logging

All runtime log output must go through the structured logger in `src/core/log.js`.
Never use `console.log`, `console.warn`, or `console.error` in runtime code.

Create a logger at module scope with the module's name as `component`:

```js
const { createLogger } = require('./src/core/log');
const logger = createLogger({ component: 'my-module' });
```

Use `logger.child({ component: '...' })` for logical sub-components within a module
(e.g. `media-ws` and `twiml` are children of `server`).

Every call should include a `message` string and an `event` field. Include `callSid`
and `reason` when applicable. Pass `Error` objects as field values directly — the
logger normalises them into `errorName`, `errorMessage`, and `errorStack`:

```js
logger.info('Thing happened', { event: 'thing-happened', callSid });
logger.error('Thing failed', { event: 'thing-failed', reason: 'why', error: err });
```

`warn` and `error` go to stderr; `debug` and `info` go to stdout.

## Keeping documentation accurate

**`README.md`** — the end-to-end test sequence contains server log examples. These
must exactly match the `message` strings, `component` values, and field names emitted
by the actual `logger.*` calls in the code. Verify against the source before writing
an example.

**`docs/architecture.md`** — the runtime components list must stay in sync with what
is actually in `src/core/`. When a module is added, removed, or its responsibilities
change, update the list. Descriptions must reflect what the module exports today, not
what it once did.

**`.env.example`** — the single source of truth for environment variables, with inline
comments and generation commands. Do not add a separate variable table to the README;
point readers to `.env.example` instead.

**`docs/testing.md`** — update the test layout section when test files are added or
removed.
