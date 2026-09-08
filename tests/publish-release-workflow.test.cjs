'use strict';

// Drift guards for .github/workflows/publish-release.yml.
// A published npm version is permanent past the 72 hour unpublish window, so the
// invariants below are checked here rather than left to review.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'publish-release.yml'),
  'utf8'
);

// Split the jobs mapping into one block of text per job. Job keys are the only
// two-space-indented keys with no inline value, so the heading regex is enough
// without pulling in a YAML parser (this repo ships no yaml dependency).
const jobs = (() => {
  const jobsIndex = workflow.indexOf('\njobs:');
  assert.notEqual(jobsIndex, -1, "publish-release.yml has no 'jobs:' mapping");
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
  assert.ok(jobs.has('publish'), 'no publish job');
  assert.match(
    jobs.get('publish'),
    /id-token: write/,
    'publish cannot authenticate to npm without id-token: write'
  );
});

test('publish job declares an environment so npm can require the claim', () => {
  assert.match(
    jobs.get('publish'),
    /environment: npm-release/,
    'the OIDC token carries no environment claim without an environment'
  );
});

test('publish job keeps a read-only contents token', () => {
  assert.match(
    jobs.get('publish'),
    /contents: read/,
    'publish should not hold a writable token while publishing'
  );
});

test('publish is gated on release-please creating a release', () => {
  assert.match(jobs.get('publish'), /needs\.release-please\.outputs\.release_created/);
  assert.match(
    jobs.get('release-please'),
    /release_created: \$\{\{ steps\.release\.outputs\.release_created \}\}/,
    'release-please must export release_created for the gate to ever be true'
  );
});

test('a prerelease reaching the release path is tagged rather than made latest', () => {
  // Reachable only via a Release-As footer, but npm publishes are permanent,
  // so the release path must not assume 'latest'.
  const publish = jobs.get('publish');
  assert.match(
    publish,
    /case "\$version" in/,
    'the release publish does not branch on the version'
  );
  assert.match(
    publish,
    /npm publish --tag "\$tag"/,
    'a prerelease from the release path would move latest'
  );
});

test('npm is new enough for trusted publishing', () => {
  // Trusted publishing needs npm >= 11.5.1, first bundled with Node 24.5.
  assert.match(jobs.get('publish'), /node-version: 24/);
});

test('top-level permissions are empty so each job scopes its own', () => {
  assert.match(workflow, /^permissions: \{\}$/m);
});
