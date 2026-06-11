# Agent guidance

This file provides guidance for AI agents working on this codebase.

## Language and module format

All runtime code is CommonJS (`require` / `module.exports`). Do not use ESM
(`import` / `export`). Test files use the `.cjs` extension.

The codebase uses JSDoc annotations throughout for type safety without a TypeScript
compilation step. Follow the existing `@param`, `@returns`, `@typedef`, and `@import`
patterns when adding or modifying functions.

## Git workflow

Never commit directly to `main` — every change lands via a pull request.

**Branches** are named `<type>/<short-description>` using the same types as commit
messages, e.g. `fix/runtime-robustness`, `docs/refresh-claude-md`.

**Commits** follow [Conventional Commits](https://www.conventionalcommits.org/):
`<type>(<optional scope>): <imperative summary>`. Allowed types are `feat`, `fix`,
`refactor`, `test`, `docs`, `chore`, and `ci`. Scope is typically the module touched
(`server`, `homekit`, `config`, `core`, `deps`). Keep each commit to one logical
change so it can be reviewed and reverted independently. Commit messages are linted
in CI (commitlint with `@commitlint/config-conventional`); run
`npx commitlint --from origin/main` to check locally.

**Pull requests** target `main`, merge in dependency order, and must pass all five
quality gates (below) locally before being opened. PR titles use the same
conventional format as commits (`type(scope): summary`, enforced in CI) — if a PR
is ever squash-merged, the title becomes the commit on `main` that release-please
and the changelog read. Releases are automated with release-please, which derives
version bumps and the changelog from commit types — `feat` commits trigger a minor
bump, `fix` a patch.

## Quality gates

Run `npm install` first if `node_modules` is absent, then run all five gates before
opening a PR:

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

Create a logger at module scope with the module's name as `component`, adjusting the
require path relative to the file:

```js
const { createLogger } = require('./src/core/log'); // from repo root
const logger = createLogger({ component: 'my-module' });
```

Use `logger.child({ component: '...' })` for logical sub-components within a module
(e.g. `media-ws` and `twiml` are children of `server`).

Every call must include a `message` string and an `event` field. Include `callSid`
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

**`docs/architecture.md`** — the runtime components list must stay in sync with
`src/core/`. When a module is added, removed, or its responsibilities change, update
the list. Descriptions must reflect what the module exports today, not what it once did.

**`.env.example`** — the single source of truth for environment variables. When adding
or changing a variable, update `.env.example` with an inline comment. The README
points readers there rather than duplicating the list.
