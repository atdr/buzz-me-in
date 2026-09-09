'use strict';

// Regression guard for the shutdown path in homekit.js.
//
// On 2026-09-09 a routine `systemctl stop` silently deleted every HomeKit
// pairing on the production Pi. The cause: shutdown() called
// accessory.destroy(), and in HAP-NodeJS destroy() is not the counterpart of
// publish() — it calls Accessory.cleanupAccessoryData(), which removes
// AccessoryInfo, IdentifierCache and ControllerStorage from persist/.
// unpublish() alone tears down the HAP server and the mDNS advertiser, which
// is all a restart should ever do.
//
// homekit.js cannot be require()d here: importing it loads config (needing a
// full env) and spawns ffmpeg for the snapshot. So this asserts against the
// source, and separately pins the upstream behaviour that makes destroy()
// dangerous, so that if a future hap-nodejs makes destroy() safe this test
// says so rather than silently over-constraining us.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'homekit.js'), 'utf8');

const shutdownBody = (() => {
  const start = source.indexOf('function shutdown()');
  assert.notEqual(start, -1, 'homekit.js has no shutdown() function');
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, 'could not find the end of shutdown()');
  return source.slice(start, end);
})();

test('shutdown unpublishes the accessory', () => {
  assert.match(
    shutdownBody,
    /accessory\.unpublish\(\)/,
    'shutdown must unpublish so the mDNS advertisement does not linger'
  );
});

test('shutdown never destroys the accessory, which would erase all pairings', () => {
  assert.doesNotMatch(
    shutdownBody,
    /accessory\.destroy\(\)/,
    'accessory.destroy() deletes persist/ and unpairs every HomeKit controller on restart'
  );
});

test('hap-nodejs destroy() still erases persisted pairing data', () => {
  // Pins the upstream hazard the guard above exists for. If this fails,
  // hap-nodejs changed destroy(): re-read it before relaxing anything.
  const accessorySource = fs.readFileSync(
    require.resolve('hap-nodejs/dist/lib/Accessory.js'),
    'utf8'
  );
  const destroyBody = (() => {
    const start = accessorySource.indexOf('Accessory.prototype.destroy = function');
    assert.notEqual(start, -1, 'hap-nodejs has no Accessory.prototype.destroy');
    const end = accessorySource.indexOf('\n    };', start);
    return accessorySource.slice(start, end);
  })();

  assert.match(
    destroyBody,
    /cleanupAccessoryData/,
    'destroy() no longer calls cleanupAccessoryData; the hazard may be gone'
  );
});
