'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, freshRequire } = require('./helpers/env.cjs');

function captureWrites(run) {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const stdout = [];
  const stderr = [];

  process.stdout.write = (chunk, encoding, callback) => {
    stdout.push(String(chunk));
    if (typeof callback === 'function') callback();
    return true;
  };
  process.stderr.write = (chunk, encoding, callback) => {
    stderr.push(String(chunk));
    if (typeof callback === 'function') callback();
    return true;
  };

  try {
    run();
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  return { stdout, stderr };
}

function parseLines(lines) {
  return lines.filter((line) => line.trim()).map((line) => JSON.parse(line));
}

describe('core logger', () => {
  test('filters messages by LOG_LEVEL', () => {
    withEnv({ LOG_LEVEL: 'warn', LOG_PRETTY: undefined }, () => {
      const { createLogger } = freshRequire('../../src/core/log');
      const logger = createLogger({ component: 'test' });

      const captured = captureWrites(() => {
        logger.debug('debug message', { event: 'debug' });
        logger.info('info message', { event: 'info' });
        logger.warn('warn message', { event: 'warn' });
        logger.error('error message', { event: 'error' });
      });

      const stdoutEvents = parseLines(captured.stdout).map((entry) => entry.event);
      const stderrEvents = parseLines(captured.stderr).map((entry) => entry.event);
      assert.deepEqual(stdoutEvents, []);
      assert.deepEqual(stderrEvents, ['warn', 'error']);
    });
  });

  test('normalizes Error fields with message and stack', () => {
    withEnv({ LOG_LEVEL: 'info', LOG_PRETTY: undefined }, () => {
      const { createLogger } = freshRequire('../../src/core/log');
      const logger = createLogger({ component: 'test' });
      const err = new Error('boom');

      const captured = captureWrites(() => {
        logger.error('operation failed', { event: 'error-test', error: err });
      });

      const [entry] = parseLines(captured.stderr);
      assert.equal(entry.message, 'operation failed');
      assert.equal(entry.event, 'error-test');
      assert.equal(entry.errorName, 'Error');
      assert.equal(entry.errorMessage, 'boom');
      assert.equal(typeof entry.errorStack, 'string');
      assert.ok(entry.errorStack.includes('Error: boom'));
    });
  });

  test('child logger inherits and merges fields', () => {
    withEnv({ LOG_LEVEL: 'info', LOG_PRETTY: undefined }, () => {
      const { createLogger } = freshRequire('../../src/core/log');
      const base = createLogger({ component: 'server' });
      const child = base.child({ component: 'media-ws', callSid: 'CA123' });

      const captured = captureWrites(() => {
        child.info('child event', { event: 'start', reason: 'ok' });
      });

      const [entry] = parseLines(captured.stdout);
      assert.equal(entry.component, 'media-ws');
      assert.equal(entry.callSid, 'CA123');
      assert.equal(entry.event, 'start');
      assert.equal(entry.reason, 'ok');
      assert.equal(entry.message, 'child event');
    });
  });

  test('falls back safely when payload serialization fails', () => {
    withEnv({ LOG_LEVEL: 'info', LOG_PRETTY: undefined }, () => {
      const { createLogger } = freshRequire('../../src/core/log');
      const logger = createLogger({ component: 'test' });
      const circular = {};
      circular.self = circular;

      const captured = captureWrites(() => {
        logger.info('will fail serialization', { event: 'circular', circular });
      });

      const [entry] = parseLines(captured.stderr);
      assert.equal(entry.level, 'error');
      assert.equal(entry.component, 'log');
      assert.equal(entry.reason, 'serialization-error');
      assert.equal(entry.message, 'Failed to serialize log payload');
      assert.equal(typeof entry.errorMessage, 'string');
      assert.equal(typeof entry.errorStack, 'string');
    });
  });
});
