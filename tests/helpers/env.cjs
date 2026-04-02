'use strict';

function applyEnv(overrides) {
  const previous = {};
  const keys = Object.keys(overrides);

  for (const key of keys) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    const value = overrides[key];
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  return () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
}

function withEnv(overrides, run) {
  const restore = applyEnv(overrides);
  try {
    return run();
  } finally {
    restore();
  }
}

function freshRequire(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

module.exports = { applyEnv, withEnv, freshRequire };
