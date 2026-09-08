'use strict';

// Drift guards for .github/workflows/publish-prerelease.yml.
// This workflow takes free-text dispatch inputs and publishes to npm, where a
// mistake is permanent past the 72 hour unpublish window. The guards below are
// the reason it is safe to expose as a manual dispatch, so they are asserted
// here rather than left to review. If one of these fails, fix the workflow.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'publish-prerelease.yml'),
  'utf8'
);

// Same regex block-split as the release workflow guard: job keys are the only
// two-space-indented keys with no inline value.
const jobs = (() => {
  const jobsIndex = workflow.indexOf('\njobs:');
  assert.notEqual(jobsIndex, -1, "publish-prerelease.yml has no 'jobs:' mapping");
  const section = workflow.slice(jobsIndex);
  const heading = /^ {2}([a-z][a-z0-9-]*):$/gm;
  const blocks = new Map();
  let previous = null;
  let match;
  while ((match = heading.exec(section)) !== null) {
    if (previous) blocks.set(previous.name, section.slice(previous.end, match.index));
    previous = { name: match[1], end: heading.lastIndex };
  }
  if (previous) blocks.set(previous.name, section.slice(previous.end));
  return blocks;
})();

test('publish job can authenticate to npm over OIDC', () => {
  assert.ok(jobs.has('publish-prerelease'), 'no publish-prerelease job');
  assert.match(jobs.get('publish-prerelease'), /id-token: write/);
});

test('publish job declares its own environment', () => {
  // A separate environment from the release path, unrestricted by branch, so a
  // beta can be dispatched from a PR branch before merge.
  assert.match(jobs.get('publish-prerelease'), /environment: npm-prerelease/);
});

test('a stable version is refused', () => {
  const job = jobs.get('publish-prerelease');
  assert.match(job, /is not a prerelease version/, 'nothing rejects a stable version');
  assert.match(job, /exit 1/);
});

test('the latest dist-tag cannot be moved', () => {
  assert.match(
    jobs.get('publish-prerelease'),
    /refusing to move the latest dist-tag/,
    'a dispatch could retag latest to a beta'
  );
});

test('dispatch inputs are read through env, never inlined into shell', () => {
  // ${{ inputs.* }} interpolated directly into a run: block is a shell injection
  // vector, since the dispatch input is arbitrary text.
  const job = jobs.get('publish-prerelease');
  assert.match(job, /VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(job, /DIST_TAG: \$\{\{ inputs\.dist_tag \}\}/);

  // Collect everything that reaches a shell: the inline remainder of a `run:`
  // line, plus the deeper-indented body of a block form. Only these are shell,
  // so an `env:` mapping carrying ${{ inputs.* }} is the safe pattern and must
  // not be flagged here.
  const lines = job.split('\n');
  const runBody = [];
  for (let i = 0; i < lines.length; i++) {
    const start = /^(\s*)run:(.*)$/.exec(lines[i]);
    if (!start) continue;
    const inline = start[2].trim();
    // '|' and '>' introduce a block; anything else on the line is the command.
    if (inline && !/^[|>][-+\d]*$/.test(inline)) runBody.push(inline);
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const indent = /^\s*/.exec(line)[0].length;
      if (indent <= start[1].length) break;
      runBody.push(line);
    }
  }
  assert.ok(runBody.length > 0, 'found no run: steps to check');

  for (const line of runBody) {
    assert.doesNotMatch(
      line,
      /\$\{\{\s*inputs\./,
      `dispatch input interpolated into a run step: ${line.trim()}`
    );
  }
});

test('the version bump is never committed', () => {
  assert.match(
    jobs.get('publish-prerelease'),
    /npm version "\$VERSION" --no-git-tag-version/,
    'a committed bump would fight the pending release-please PR'
  );
});

test('the publish is tagged, never latest', () => {
  assert.match(jobs.get('publish-prerelease'), /npm publish --tag "\$DIST_TAG"/);
});

test('the published commit is recorded as a bare ref, not a GitHub Release', () => {
  // release-please reads the Releases API to find the last release and does not
  // filter out prereleases, so a prerelease Release would outrank the real one
  // and become the base it bumps from.
  const job = jobs.get('tag-prerelease');
  assert.ok(job, 'no tag-prerelease job');
  assert.match(job, /refs\/tags\/prerelease\//);
  assert.doesNotMatch(job, /gh release create/, 'a GitHub Release would confuse release-please');
});

test('the tagging job is separate so the publish token stays read-only', () => {
  assert.match(jobs.get('publish-prerelease'), /contents: read/);
  assert.match(jobs.get('tag-prerelease'), /needs: publish-prerelease/);
});

test('npm is new enough for trusted publishing', () => {
  assert.match(jobs.get('publish-prerelease'), /node-version: 24/);
});
