'use strict';

// Drift guards for the coverage job in .github/workflows/ci.yml and the `coverage`
// script it runs. Coverage is reporting, not one of the five gates: the Node matrix is
// what proves the suite passes. But a report that quietly measures the wrong thing is
// worse than no report, because the number still looks authoritative.
//
// Three invariants are easy to lose and silent when lost:
//
// 1. Scope. V8 reports every file that was loaded, so without
//    --test-coverage-include the report also covers tests/ and the helper shims. The
//    include list is pinned to package.json's `files` array so what is measured is
//    exactly what ships, minus the two entries below that cannot be loaded.
//
// 2. Preload. V8 reports nothing at all for a file no test ever loaded, rather than
//    reporting it at 0%. twilio-api.js is required by no test, so dropping the
//    --require flag does not lower the score. It deletes the least-tested shipped
//    module from the report and raises it.
//
// 3. The exclusions stay honest. server.js and homekit.js are shipped code that this
//    repo cannot preload: requiring server.js binds PORT, and requiring homekit.js
//    publishes the HAP accessory and spawns ffmpeg, which leaves the test runner with
//    open handles and hangs it. They are therefore named here rather than quietly
//    missing, so the headline number is understood as "src/ plus twilio-api.js".
//
// CI runs `npm run coverage` rather than its own command line, so all of it is checked
// once here and holds locally and in CI alike.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const pkg = JSON.parse(read('package.json'));
const script = pkg.scripts.coverage ?? '';
const workflow = read('.github/workflows/ci.yml');

// The LCOV file name has to agree in three places: the script that writes it, the CI
// step that uploads it, and .gitignore. Take the script as the source of truth.
const LCOV = 'lcov.info';

// Shipped code that cannot be require()d in-process. Keep in sync with the comment at
// the top of this file — removing an entry here means it must join the include list.
const UNLOADABLE = ['server.js', 'homekit.js'];

const PRELOAD = './tests/helpers/coverage-preload.cjs';

// Job keys are the only two-space indented keys with no inline value, so a heading
// regex suffices without a YAML parser (this repo ships no YAML dependency).
const jobs = (() => {
  const jobsIndex = workflow.indexOf('\njobs:');
  assert.notEqual(jobsIndex, -1, "ci.yml has no 'jobs:' mapping");
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

describe('coverage script', () => {
  test('exists', () => {
    assert.ok(pkg.scripts.coverage, 'package.json needs a coverage script; ci.yml runs it');
  });

  test('measures every shipped code file it can load', () => {
    // A new shipped directory or module should fail here until it is added to the
    // include list, rather than silently sitting outside the measurement.
    const expected = pkg.files
      .filter((entry) => entry.endsWith('.js') || entry.endsWith('/'))
      .filter((entry) => !UNLOADABLE.includes(entry))
      .map((entry) => (entry.endsWith('/') ? `${entry}**` : entry))
      .sort();
    const includes = [...script.matchAll(/--test-coverage-include='([^']+)'/g)]
      .map((m) => m[1])
      .sort();
    assert.deepEqual(
      includes,
      expected,
      'the --test-coverage-include list must cover every loadable code entry in the package files array'
    );
  });

  test('preloads the source no test requires', () => {
    // Without this the report omits twilio-api.js entirely, which raises the headline
    // percentage instead of lowering it.
    assert.ok(
      script.includes(`--require ${PRELOAD}`),
      `coverage must preload via ${PRELOAD}, or V8 drops twilio-api.js from the report rather than scoring it`
    );
    assert.match(
      read(PRELOAD),
      /require\('\.\.\/\.\.\/twilio-api\.js'\)/,
      'the preload exists to load twilio-api.js; loading nothing makes the flag a no-op'
    );
  });

  test('keeps the unloadable modules out of the preload', () => {
    // Requiring either binds a port or publishes the accessory and spawns ffmpeg,
    // leaving open handles that hang `node --test` rather than failing it.
    const preload = read(PRELOAD);
    for (const entry of UNLOADABLE) {
      assert.doesNotMatch(
        preload,
        new RegExp(`require\\('\\.\\./\\.\\./${entry.replace('.', '\\.')}'\\)`),
        `${entry} cannot be preloaded: it has module-scope side effects that hang the test runner`
      );
    }
  });

  test('runs against the same clean environment as the suite', () => {
    // The suite relies on DOTENV_CONFIG_PATH=/dev/null so a developer's local .env
    // cannot leak values in. A coverage run without it measures a different program.
    assert.match(script, /DOTENV_CONFIG_PATH=\/dev\/null/);
  });

  test(`writes ${LCOV} for the upload`, () => {
    assert.match(script, /--test-reporter=lcov/);
    assert.match(script, new RegExp(`--test-reporter-destination=${LCOV.replace('.', '\\.')}`));
  });

  test('stays out of the gates a Node 20 developer runs', () => {
    // --test-coverage-include needs Node >= 22.5, below which node exits on the unknown
    // flag. package.json still declares a >=20 engines floor, so no gate may need it.
    for (const gate of ['test', 'lint', 'format:check', 'check', 'typecheck']) {
      assert.doesNotMatch(
        pkg.scripts[gate] ?? '',
        /coverage/,
        `the ${gate} gate must not depend on coverage; it needs Node >= 22.5`
      );
    }
  });
});

describe('CI coverage job', () => {
  const job = () => {
    const block = jobs.get('coverage');
    assert.ok(block, 'no coverage job in ci.yml');
    return block;
  };

  test('runs the same command as a developer would', () => {
    assert.match(
      job(),
      /run: npm run coverage/,
      'CI must call the npm script, so CI and local cannot drift apart'
    );
  });

  test('runs on a Node new enough for the coverage flags', () => {
    const version = job().match(/node-version: (\d+)/);
    assert.ok(version, 'the coverage job must pin a node-version');
    assert.ok(
      Number(version[1]) >= 22,
      '--test-coverage-include needs Node >= 22.5; the repo floor of 20 exits on the unknown flag'
    );
  });

  test('uploads the file the script writes', () => {
    assert.match(job(), new RegExp(`files: \\./${LCOV.replace('.', '\\.')}`));
    assert.match(job(), /uses: codecov\/codecov-action@v\d+/);
  });

  test('lets the upload fail without failing the job', () => {
    // An outage at Codecov, or a missing CODECOV_TOKEN, says nothing about the change
    // under review. The coverage run itself stays blocking: a job that can never fail
    // is a check that proves nothing.
    const upload = job().slice(job().indexOf('codecov/codecov-action'));
    assert.match(upload, /fail_ci_if_error: false/);
    assert.doesNotMatch(
      job(),
      /^ {4}continue-on-error: true/m,
      'continue-on-error belongs on the upload step, not the job'
    );
  });
});

describe('coverage reporting config', () => {
  test(`keeps ${LCOV} out of git`, () => {
    assert.ok(
      read('.gitignore')
        .split('\n')
        .some((line) => line.trim() === LCOV),
      `.gitignore must list ${LCOV}; the existing *.lcov entry does not match it`
    );
  });

  test('leaves Codecov unable to block a merge', () => {
    // Without this, Codecov adds two status checks it owns to every PR. CI is the gate.
    const codecov = read('codecov.yml');
    const informational = [...codecov.matchAll(/informational: true/g)];
    assert.equal(
      informational.length,
      2,
      'both the project and patch statuses must be informational'
    );
    for (const status of ['project:', 'patch:']) {
      assert.ok(
        codecov.includes(status),
        `codecov.yml must configure the ${status.slice(0, -1)} status`
      );
    }
  });

  test('is advertised in the README', () => {
    assert.match(read('README.md'), /codecov\.io\/gh\/atdr\/buzz-me-in/);
  });
});
