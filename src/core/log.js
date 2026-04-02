'use strict';

/** @import { LogFields } from './types.js' */

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_LEVEL = 'info';
const PRETTY_LOGS = process.env.LOG_PRETTY === '1';

/**
 * @param {unknown} value
 * @returns {LogFields}
 */
function normalizeFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  /** @type {LogFields} */
  const normalized = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (fieldValue === undefined) continue;
    if (fieldValue instanceof Error) {
      normalized.errorName = fieldValue.name;
      normalized.errorMessage = fieldValue.message;
      normalized.errorStack = fieldValue.stack || '';
      continue;
    }
    normalized[key] = fieldValue;
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @returns {'debug' | 'info' | 'warn' | 'error'}
 */
function parseLevel(value) {
  if (typeof value !== 'string') return DEFAULT_LEVEL;
  const lower = value.toLowerCase();
  if (lower === 'debug' || lower === 'info' || lower === 'warn' || lower === 'error') {
    return lower;
  }
  return DEFAULT_LEVEL;
}

const ACTIVE_LEVEL = parseLevel(process.env.LOG_LEVEL);

/**
 * @param {'debug' | 'info' | 'warn' | 'error'} level
 * @returns {boolean}
 */
function shouldLog(level) {
  return LEVELS[level] >= LEVELS[ACTIVE_LEVEL];
}

/**
 * @param {'debug' | 'info' | 'warn' | 'error'} level
 * @param {LogFields} payload
 */
function emit(level, payload) {
  const target = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  try {
    const line = PRETTY_LOGS ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
    target.write(`${line}\n`);
  } catch (err) {
    const fallback = {
      ts: new Date().toISOString(),
      level: 'error',
      message: 'Failed to serialize log payload',
      component: 'log',
      reason: 'serialization-error',
      errorMessage: err instanceof Error ? err.message : String(err),
      errorStack: err instanceof Error && err.stack ? err.stack : '',
    };
    target.write(`${JSON.stringify(fallback)}\n`);
  }
}

/**
 * @param {LogFields} [baseFields]
 */
function createLogger(baseFields) {
  const base = normalizeFields(baseFields);

  /**
   * @param {'debug' | 'info' | 'warn' | 'error'} level
   * @param {string} message
   * @param {LogFields} [fields]
   */
  function logAt(level, message, fields) {
    if (!shouldLog(level)) return;
    const payload = {
      ts: new Date().toISOString(),
      level,
      message,
      ...base,
      ...normalizeFields(fields),
    };
    emit(level, payload);
  }

  return {
    /** @param {string} message @param {LogFields} [fields] */
    debug(message, fields) {
      logAt('debug', message, fields);
    },
    /** @param {string} message @param {LogFields} [fields] */
    info(message, fields) {
      logAt('info', message, fields);
    },
    /** @param {string} message @param {LogFields} [fields] */
    warn(message, fields) {
      logAt('warn', message, fields);
    },
    /** @param {string} message @param {LogFields} [fields] */
    error(message, fields) {
      logAt('error', message, fields);
    },
    /** @param {LogFields} fields */
    child(fields) {
      return createLogger({ ...base, ...normalizeFields(fields) });
    },
  };
}

module.exports = {
  createLogger,
};
