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
//    include list is pinned to package.json's `files` array, so a newly shipped module
//    fails here until it is measured rather than sitting silently outside the number.
//
// 2. Preload. V8 reports nothing at all for a file no test ever loaded, rather than
//    reporting it at 0%. server.js, homekit.js and twilio-api.js are required by no
//    test, so dropping the --require flag does not lower the score. It deletes the
//    three least-tested shipped modules from the report and raises it.
//
// 3. Inert module scope. The preload can only load the two entry points because
//    neither acts when required: server.js listens, installs signal handlers and
//    parses CLI flags inside main(), homekit.js publishes the accessory and spawns
//    ffmpeg inside start(), and both are gated on `require.main === module`. Undo that
//    and the coverage run binds PORT, advertises a second accessory over Avahi next to
//    the live service, and hangs `node --test` on the open handles. The guards below
//    fail on the source rather than waiting for CI to time out.
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

  test('measures every shipped code file', () => {
    // A new shipped directory or module should fail here until it is added to the
    // include list, rather than silently sitting outside the measurement.
    const expected = pkg.files
      .filter((entry) => entry.endsWith('.js') || entry.endsWith('/'))
      .map((entry) => (entry.endsWith('/') ? `${entry}**` : entry))
      .sort();
    const includes = [...script.matchAll(/--test-coverage-include='([^']+)'/g)]
      .map((m) => m[1])
      .sort();
    assert.deepEqual(
      includes,
      expected,
      'the --test-coverage-include list must cover every code entry in the package files array'
    );
  });

  test('preloads the sources no test requires', () => {
    // Without these the report omits the three entirely, which raises the headline
    // percentage instead of lowering it.
    assert.ok(
      script.includes(`--require ${PRELOAD}`),
      `coverage must preload via ${PRELOAD}, or V8 drops the untested modules from the report rather than scoring them`
    );
    const preload = read(PRELOAD);
    for (const entry of ['twilio-api.js', 'homekit.js', 'server.js']) {
      assert.match(
        preload,
        new RegExp(`require\\('\\.\\./\\.\\./${entry.replace('.', '\\.')}'\\)`),
        `the preload must require ${entry}; otherwise it is absent from the report, not scored 0%`
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

describe('entry points stay inert when required', () => {
  // The preload, and so the whole measurement, rests on this. It is also the property
  // that makes `buzz-me-in --qr` safe to run against a live deployment: a read-only
  // query must not advertise a second accessory or bind the port.
  const server = read('server.js');
  const homekit = read('homekit.js');

  test('server.js only starts itself when it is the entry point', () => {
    assert.match(
      server,
      /if \(require\.main === module\) main\(\);/,
      'server.js must call main() behind a require.main guard, not at module scope'
    );
  });

  test('server.js keeps its side effects inside main()', () => {
    const body = server.slice(server.indexOf('function main()'));
    for (const effect of ['wsserver.listen(', "process.on('SIGINT'", "process.on('SIGTERM'"]) {
      assert.ok(body.includes(effect), `main() must own ${effect}`);
    }
    // An uncaughtException handler installed by merely requiring this file would
    // call process.exit(1) on a test's own failure and report it as a pass.
    const moduleScope = server.slice(0, server.indexOf('function main()'));
    assert.doesNotMatch(
      moduleScope,
      /^process\.on\(/m,
      'process-level handlers belong in main(); at module scope they follow every require'
    );
    assert.doesNotMatch(
      moduleScope,
      /^wsserver\.listen\(/m,
      'listening at module scope binds PORT on every require'
    );
  });

  test('server.js parses CLI flags only when run', () => {
    // process.argv belongs to whatever loaded this file. Under `node --test` that is
    // a list of test files, which must not be read as intercom flags.
    const cliCall = server.indexOf("require('./src/core/cli').run(");
    assert.notEqual(cliCall, -1, 'server.js no longer calls cli.run()');
    const guard = server.lastIndexOf('if (require.main === module) {', cliCall);
    assert.notEqual(guard, -1, 'the cli.run() block must sit behind a require.main guard');
  });

  test('homekit.js publishes only from start()', () => {
    const startBody = homekit.slice(homekit.indexOf('function start()'));
    for (const effect of ['accessory.publish(', 'initSnapshot(']) {
      assert.ok(startBody.includes(effect), `start() must own ${effect}`);
    }
    const moduleScope = homekit.slice(0, homekit.indexOf('function start()'));
    assert.doesNotMatch(
      moduleScope,
      /^accessory\.publish\(/m,
      'publishing at module scope puts a second accessory on the network on every require'
    );
    assert.doesNotMatch(
      moduleScope,
      /^initSnapshot\(\)/m,
      'spawning ffmpeg at module scope runs on every require, including read-only CLI queries'
    );
  });

  test('server.js starts the accessory before it accepts traffic', () => {
    const body = server.slice(server.indexOf('function main()'));
    assert.ok(
      body.indexOf('homekit.start()') < body.indexOf('wsserver.listen('),
      'the accessory must be published before the port accepts a Twilio stream'
    );
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
