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
in CI (commitlint with `@commitlint/config-conventional`) and locally by a husky
`commit-msg` hook, which `npm install` sets up automatically. A `pre-commit` hook
runs lint-staged (ESLint + Prettier on staged files only); the five full quality
gates stay in CI and remain the documented pre-PR step.

**Pull requests** target `main`, merge in dependency order, and must pass all five
quality gates (below) locally before being opened. PR titles use the same
conventional format as commits (`type(scope): summary`, enforced in CI) because the
title becomes the commit on `main` that release-please and the changelog read.

**Squash-merge every PR.** `gh pr merge <n> --squash`, and the repository allows no
other method. A merge commit made by `gh pr merge --merge` carries the PR title in
its _body_, which release-please parses as a second conventional commit and emits as
a duplicate changelog entry — this produced two identical lines under 2.0.1 before
the method was pinned. Squashing also keeps one commit per change on `main`, so a
revert is one `git revert`.

Releases are automated with release-please, which derives version bumps and the
changelog from commit types — `feat` commits trigger a minor bump, `fix` a patch.

**Release PRs need their CI approved before merging.** release-please authors them
with the default `GITHUB_TOKEN`, so their workflow runs sit in `action_required` and
`gh pr checks` reports _no checks at all_, which reads as nothing-failing. Find them
with `gh run list --branch <head> --json conclusion,workflowName,databaseId --jq '.[] | select(.conclusion=="action_required")'`
and approve with `gh api --method POST repos/<owner>/<repo>/actions/runs/<id>/approve`.

Merging the release PR also publishes to npm as `buzz-me-in`, from
`.github/workflows/publish-release.yml`. Prereleases are a manual dispatch of
`publish-prerelease.yml`. Both authenticate over OIDC trusted publishing, so there
is no `NPM_TOKEN` stored anywhere and provenance is attached automatically; the
trusted publisher itself is configured on npmjs.com against the package. Both
workflows are guarded by `tests/publish-*-workflow.test.cjs` — fix the workflow,
not the test.

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

A PR that adds or removes a module, test file, HTTP endpoint, env var, or CI job must
update the affected docs in the same PR. Before opening a PR, grep the docs for names
related to your change. Specific sync rules:

**`README.md`** — the end-to-end test sequence contains server log examples. These
must exactly match the `message` strings, `component` values, and field names emitted
by the actual `logger.*` calls in the code. Verify against the source before writing
an example. The file structure tree must track added/removed modules and top-level
files. Endpoint claims (routes, auth, response shapes in the HTTP endpoints table and
test stages) must match the routes in `server.js`. Setup steps may only reference
files that exist in the repo.

**`docs/architecture.md`** — the runtime components list must stay in sync with
`src/core/`. When a module is added, removed, or its responsibilities change, update
the list. Descriptions must reflect what the module exports today, not what it once
did. The auth boundaries section must list every endpoint, including intentionally
unauthenticated ones.

**`docs/testing.md`** — adding or removing a test file updates the Test layout list.
Changing CI workflows, git hooks, or release automation updates the CI notes section.

**`.env.example`** — the single source of truth for environment variables. When adding
or changing a variable, update `.env.example` with an inline comment. The README
points readers there rather than duplicating the list.
