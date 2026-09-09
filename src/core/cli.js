'use strict';

// Read-only CLI queries against the pairing state in persist/.
//
// These exist because the server only prints the HomeKit setup QR when stdout
// is a TTY (homekit.js), which under systemd is never. Recovering a lost
// pairing therefore had no supported path. They also expose pairedClients,
// which is the one number that reveals an accessory has been silently
// unpaired (see tests/homekit-shutdown.test.cjs for how that used to happen).
//
// Nothing here starts a server, contacts HomeKit, or signals a running
// instance. run() is called from server.js BEFORE any other require, because
// requiring ./homekit publishes an accessory at module scope and requiring
// ./src/core/config throws on a missing env var.

const fs = require('fs');
const path = require('path');

const PERSIST_DIR_NAME = 'persist';
const ACCESSORY_INFO_PREFIX = 'AccessoryInfo.';

const USAGE = `buzz-me-in - HomeKit-compatible apartment intercom via Twilio media streams

Usage:
  buzz-me-in             Start the server
  buzz-me-in --qr        Print the HomeKit setup QR for the accessory (terminal only)
  buzz-me-in --check     Report pairing state: persist directory, accessory, paired clients
  buzz-me-in --help      Show this message
  buzz-me-in --version   Print the version

--qr and --check read ${PERSIST_DIR_NAME}/ under the current working directory. They do
not start the server, contact HomeKit, or signal a running instance, so they
are safe to run against a live deployment.

--qr requires a terminal: the URI it encodes contains the setup code, so it is
refused on a pipe or a non-interactive SSH command. Use 'ssh -t'.
`;

/**
 * Absolute path of the directory HAP-NodeJS persists pairing state into.
 *
 * HAP-NodeJS never calls HAPStorage.setCustomStoragePath, so HAPStorage calls
 * node-persist's initSync() with no argument. That skips setOptions(), which is
 * the only place a relative dir is made absolute, so the option stays the
 * literal string 'persist' from node-persist's defaults and every fs call
 * resolves it against process.cwd(). Hence <cwd>/persist, which under systemd
 * is <WorkingDirectory>/persist. tests/cli.test.cjs pins that default so a
 * node-persist upgrade cannot move it silently.
 *
 * @param {string} cwd
 * @returns {string}
 */
function resolvePersistDir(cwd) {
  return path.resolve(cwd, PERSIST_DIR_NAME);
}

/**
 * @typedef {object} AccessoryInfoFile
 * @property {string} file Basename of the AccessoryInfo JSON.
 * @property {string[]} allFiles Every AccessoryInfo JSON found, sorted.
 * @property {any} info Parsed contents.
 */

/**
 * Locate and parse the persisted AccessoryInfo.
 *
 * @param {string} persistDir
 * @returns {AccessoryInfoFile}
 * @throws {Error & { code: string }} with code 'PERSIST_MISSING' or 'NO_ACCESSORY_INFO'.
 */
function readAccessoryInfo(persistDir) {
  /** @param {string} code @param {string} message */
  const fail = (code, message) => {
    const error = /** @type {Error & { code: string }} */ (new Error(message));
    error.code = code;
    throw error;
  };

  let entries;
  try {
    entries = fs.readdirSync(persistDir);
  } catch {
    fail('PERSIST_MISSING', `No pairing directory at ${persistDir}`);
    throw new Error('unreachable');
  }

  const allFiles = entries.filter((name) => name.startsWith(ACCESSORY_INFO_PREFIX)).sort();
  if (allFiles.length === 0) {
    fail('NO_ACCESSORY_INFO', `No ${ACCESSORY_INFO_PREFIX}*.json in ${persistDir}`);
  }

  return {
    file: allFiles[0],
    allFiles,
    info: JSON.parse(fs.readFileSync(path.join(persistDir, allFiles[0]), 'utf8')),
  };
}

/**
 * Build the X-HM:// setup URI for a persisted accessory.
 *
 * This delegates to HAP-NodeJS rather than reimplementing the encoding. The
 * upstream zero-padding loop re-reads the string's length as it grows
 * (`for (i = 0; i <= 9 - encodedPayload.length; i++)`), so it converges on nine
 * characters from a seven-character payload but eight from a five-character
 * one. Any local reimplementation therefore agrees only for some categories,
 * and a QR that differs by one character scans to nothing.
 *
 * Accessory.prototype.setupURI reads only `_accessoryInfo.pincode`,
 * `_accessoryInfo.category` and `_setupID`, so a plain object stands in for a
 * published accessory: no HAP server, no mDNS advertiser, no storage. That is
 * a private API, pinned by tests/cli.test.cjs so a rename fails there rather
 * than producing an unscannable code here.
 *
 * @param {{ pincode: string, category: number, setupID: string }} info
 * @returns {string}
 */
function computeSetupUri(info) {
  const { Accessory } = require('hap-nodejs');
  /** @type {any} */
  const publishedAccessoryStub = {
    _accessoryInfo: { pincode: info.pincode, category: info.category },
    _setupID: info.setupID,
  };
  return Accessory.prototype.setupURI.call(publishedAccessoryStub);
}

/**
 * @param {any} info
 * @returns {number}
 */
function countPairedClients(info) {
  return Object.keys(info?.pairedClients || {}).length;
}

/** @returns {string} */
function readVersion() {
  const packageJson = path.join(__dirname, '..', '..', 'package.json');
  return JSON.parse(fs.readFileSync(packageJson, 'utf8')).version;
}

/**
 * @param {Error & { code?: string }} error
 * @returns {string}
 */
function explainLookupFailure(error) {
  if (error.code !== 'PERSIST_MISSING' && error.code !== 'NO_ACCESSORY_INFO') throw error;
  return (
    `${error.message}\n` +
    `\nPairing state lives in ./${PERSIST_DIR_NAME} under the server's working directory, so run\n` +
    `this from there. On a systemd host:\n` +
    `\n  cd "$(systemctl show intercom -p WorkingDirectory --value)" && buzz-me-in\n`
  );
}

/**
 * Handle a CLI invocation.
 *
 * @param {object} options
 * @param {string[]} options.argv Arguments after the executable and script.
 * @param {(text: string) => void} options.write stdout sink.
 * @param {(text: string) => void} options.writeErr stderr sink.
 * @param {boolean} options.isTTY Whether stdout is an interactive terminal.
 * @param {string} options.cwd Directory to resolve persist/ against.
 * @returns {number | null} An exit code, or null meaning "start the server".
 */
function run({ argv, write, writeErr, isTTY, cwd }) {
  if (argv.length === 0) return null;

  const flag = argv[0];

  if (flag === '--help' || flag === '-h') {
    write(USAGE);
    return 0;
  }

  if (flag === '--version' || flag === '-v') {
    write(`${readVersion()}\n`);
    return 0;
  }

  if (flag !== '--qr' && flag !== '--check') {
    writeErr(`Unknown option: ${flag}\n\n${USAGE}`);
    return 2;
  }

  // Checked before reading anything, so a piped --qr cannot be told whether an
  // accessory exists either.
  if (flag === '--qr' && !isTTY) {
    writeErr(
      'Refusing to print the pairing QR to a non-TTY: it encodes the setup code.\n' +
        "Run it from a terminal, e.g.  ssh -t <host> 'cd <working-directory> && buzz-me-in --qr'\n"
    );
    return 1;
  }

  const persistDir = resolvePersistDir(cwd);

  let accessory;
  try {
    accessory = readAccessoryInfo(persistDir);
  } catch (error) {
    writeErr(explainLookupFailure(/** @type {Error & { code?: string }} */ (error)));
    return 1;
  }

  const { file, allFiles, info } = accessory;
  const pairedClients = countPairedClients(info);

  if (flag === '--check') {
    write(
      `persistDir    : ${persistDir}\n` +
        `accessoryInfo : ${allFiles.join(', ')}\n` +
        `category      : ${info.category}${info.category === 18 ? ' (video doorbell)' : ''}\n` +
        `setupID       : ${info.setupID ? 'present' : 'MISSING'}\n` +
        `pairedClients : ${pairedClients}\n`
    );
    return 0;
  }

  // Two accessories means two pincodes, and printing the wrong one sends the
  // user round a pairing loop with no indication why. HAP_USERNAME in .env
  // decides which is live, and this command deliberately does not read .env.
  if (allFiles.length > 1) {
    writeErr(
      `Found ${allFiles.length} accessories in ${persistDir}:\n` +
        allFiles.map((name) => `  ${name}\n`).join('') +
        '\nRefusing to guess which one is live. HAP_USERNAME in .env decides;\n' +
        'move the stale files aside and run --qr again.\n'
    );
    return 1;
  }

  if (!info.setupID || !info.pincode) {
    writeErr(`${file} has no setupID or pincode; it cannot produce a setup QR.\n`);
    return 1;
  }

  const uri = computeSetupUri(info);
  const qrcode = require('qrcode-terminal');

  write('\n  Home app → Add Accessory → scan this:\n\n');
  qrcode.generate(uri, { small: true }, (/** @type {string} */ rendered) => write(rendered));
  write(`\n  Paired clients right now: ${pairedClients}\n\n`);
  return 0;
}

module.exports = {
  PERSIST_DIR_NAME,
  USAGE,
  computeSetupUri,
  countPairedClients,
  readAccessoryInfo,
  resolvePersistDir,
  run,
};
