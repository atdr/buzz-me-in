'use strict';

// Tests for the read-only CLI queries in src/core/cli.js (--qr, --check,
// --help, --version), plus the two upstream behaviours they are built on.
//
// Three of these are pinning tests rather than tests of our own logic. They
// exist because the failure they guard against is silent: a QR that differs by
// one character still renders, still scans, and simply pairs nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../src/core/cli');

// pincode/category/setupID chosen so the expected URI can be stated literally.
// Verified against hap-nodejs' own Accessory.prototype.setupURI().
const ACCESSORY = {
  displayName: 'Apartment Intercom',
  category: 18,
  pincode: '031-45-154',
  setupID: 'ABCD',
  pairedClients: { 'client-a': 'aa', 'client-b': 'bb' },
};
const EXPECTED_URI = 'X-HM://00HVRPEPUABCD';

/**
 * Build a throwaway working directory. `persist` is a map of filename to
 * contents; omit it entirely to leave no persist/ directory at all.
 */
function makeWorkDir(t, persist) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzz-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  if (persist) {
    const persistDir = path.join(dir, 'persist');
    fs.mkdirSync(persistDir);
    for (const [name, contents] of Object.entries(persist)) {
      fs.writeFileSync(path.join(persistDir, name), JSON.stringify(contents));
    }
  }
  return dir;
}

function invoke(argv, { cwd = process.cwd(), isTTY = true } = {}) {
  let out = '';
  let err = '';
  const code = cli.run({
    argv,
    write: (text) => {
      out += text;
    },
    writeErr: (text) => {
      err += text;
    },
    isTTY,
    cwd,
  });
  return { code, out, err };
}

const withAccessory = (t) => makeWorkDir(t, { 'AccessoryInfo.DEADBEEF.json': ACCESSORY });

test('no arguments falls through so the systemd unit still starts the server', () => {
  // ExecStart is a bare `buzz-me-in`. If this ever returns an exit code the
  // service stops booting.
  assert.equal(invoke([]).code, null);
});

test('--version prints the package version', () => {
  const expected = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  ).version;
  const { code, out } = invoke(['--version']);
  assert.equal(code, 0);
  assert.equal(out.trim(), expected);
});

test('--help documents every flag', () => {
  const { code, out } = invoke(['--help']);
  assert.equal(code, 0);
  for (const flag of ['--qr', '--check', '--help', '--version']) {
    assert.match(out, new RegExp(`\\${flag}\\b`), `usage does not mention ${flag}`);
  }
});

test('an unknown flag exits 2 with usage on stderr', () => {
  const { code, out, err } = invoke(['--nope']);
  assert.equal(code, 2);
  assert.equal(out, '');
  assert.match(err, /Unknown option: --nope/);
  assert.match(err, /Usage:/);
});

test('--qr refuses a non-TTY and leaks the URI to neither stream', (t) => {
  const cwd = withAccessory(t);
  const { code, out, err } = invoke(['--qr'], { cwd, isTTY: false });
  assert.equal(code, 1);
  assert.match(err, /Refusing to print the pairing QR to a non-TTY/);
  assert.match(err, /ssh -t/);
  for (const stream of [out, err]) {
    assert.doesNotMatch(stream, /X-HM:\/\//);
    assert.doesNotMatch(stream, /031-45-154/);
  }
});

test('--qr renders a QR and reports the paired client count', (t) => {
  const cwd = withAccessory(t);
  const { code, out, err } = invoke(['--qr'], { cwd, isTTY: true });
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.match(out, /Add Accessory/);
  // qrcode-terminal's small mode draws with half-block glyphs.
  assert.match(out, /[▀▄█]/);
  assert.match(out, /Paired clients right now: 2/);
});

test('--check reports pairing state without a TTY and without secrets', (t) => {
  const cwd = withAccessory(t);
  const { code, out, err } = invoke(['--check'], { cwd, isTTY: false });
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.match(out, new RegExp(`persistDir\\s+: ${path.join(cwd, 'persist')}`));
  assert.match(out, /accessoryInfo\s+: AccessoryInfo\.DEADBEEF\.json/);
  assert.match(out, /category\s+: 18 \(video doorbell\)/);
  assert.match(out, /setupID\s+: present/);
  assert.match(out, /pairedClients\s+: 2/);
  // The whole point of --check being TTY-free is that it is safe to pipe.
  assert.doesNotMatch(out, /X-HM:\/\//);
  assert.doesNotMatch(out, /031-45-154/);
});

test('a missing persist directory names the path and explains where to run', (t) => {
  const cwd = makeWorkDir(t, null);
  const { code, err } = invoke(['--check'], { cwd });
  assert.equal(code, 1);
  assert.match(err, new RegExp(`No pairing directory at ${path.join(cwd, 'persist')}`));
  assert.match(err, /systemctl show intercom -p WorkingDirectory/);
});

test('an empty persist directory reports a different failure', (t) => {
  const cwd = makeWorkDir(t, {});
  const { code, err } = invoke(['--check'], { cwd });
  assert.equal(code, 1);
  assert.match(err, /No AccessoryInfo\.\*\.json/);
  assert.doesNotMatch(err, /No pairing directory/);
});

test('--qr refuses to guess between two accessories', (t) => {
  // A changed HAP_USERNAME leaves the old AccessoryInfo behind. Printing the
  // stale pincode sends the user round a pairing loop with no clue why.
  const cwd = makeWorkDir(t, {
    'AccessoryInfo.AAAAAAAA.json': ACCESSORY,
    'AccessoryInfo.BBBBBBBB.json': { ...ACCESSORY, pincode: '111-22-333' },
  });
  const { code, out, err } = invoke(['--qr'], { cwd, isTTY: true });
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.match(err, /Refusing to guess/);
  assert.match(err, /HAP_USERNAME/);

  // --check still works, and lists both so the user can see the problem.
  const check = invoke(['--check'], { cwd, isTTY: false });
  assert.equal(check.code, 0);
  assert.match(check.out, /AccessoryInfo\.AAAAAAAA\.json, AccessoryInfo\.BBBBBBBB\.json/);
});

test('computeSetupUri produces the known-good URI', () => {
  assert.equal(cli.computeSetupUri(ACCESSORY), EXPECTED_URI);
});

test('hap-nodejs still exposes the private setupURI shape we delegate to', () => {
  // computeSetupUri calls Accessory.prototype.setupURI against a stub object.
  // If upstream renames _accessoryInfo or _setupID, or drops the method, that
  // must fail here rather than by emitting a QR that pairs nothing.
  const { Accessory } = require('hap-nodejs');
  assert.equal(typeof Accessory.prototype.setupURI, 'function');

  const uri = Accessory.prototype.setupURI.call({
    _accessoryInfo: { pincode: ACCESSORY.pincode, category: ACCESSORY.category },
    _setupID: ACCESSORY.setupID,
  });
  assert.equal(uri, EXPECTED_URI);
});

test("node-persist's default storage dir is still a relative 'persist'", () => {
  // resolvePersistDir rests on this: HAPStorage calls initSync() with no
  // options, which skips setOptions() and so never makes the dir absolute,
  // leaving every fs call to resolve it against process.cwd().
  const store = require('node-persist').create();
  assert.equal(store.options.dir, 'persist');
  assert.equal(path.isAbsolute(store.options.dir), false);
  assert.equal(cli.resolvePersistDir('/srv/intercom'), path.join('/srv/intercom', 'persist'));
});

test('server.js handles CLI flags before requiring homekit or config', () => {
  // server.js cannot be require()d here: it starts an HTTP server. Requiring
  // ./homekit publishes a HomeKit accessory at module scope, so a --qr run that
  // reached it would advertise a second accessory alongside the live service;
  // requiring ./src/core/config throws on any missing env var. Both are wrong
  // for a read-only query, and both are easy to reintroduce by tidying the
  // requires into alphabetical order.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  const cliRun = source.indexOf("require('./src/core/cli').run(");
  const homekit = source.indexOf("require('./homekit')");
  const config = source.indexOf("require('./src/core/config')");

  assert.notEqual(cliRun, -1, 'server.js does not call cli.run()');
  assert.notEqual(homekit, -1, 'server.js no longer requires ./homekit');
  assert.notEqual(config, -1, 'server.js no longer requires ./src/core/config');

  assert.ok(cliRun < homekit, 'cli.run() must come before require("./homekit")');
  assert.ok(cliRun < config, 'cli.run() must come before require("./src/core/config")');
});
