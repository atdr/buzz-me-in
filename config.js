'use strict';

require('dotenv').config();

function fail(message) {
  throw new Error(`[config] ${message}`);
}

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) fail(`Missing required env var: ${name}`);
  return value.trim();
}

function optional(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

function parsePort(name, fallback) {
  const raw = process.env[name];
  const value = raw && raw.trim() ? raw.trim() : fallback;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`${name} must be a valid TCP/UDP port`);
  }
  return port;
}

function validateRegex(name, value, regex, description) {
  if (!regex.test(value)) {
    fail(`${name} must match ${description}`);
  }
  return value;
}

function sanitizeBaseUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    fail('TWILIO_WEBHOOK_BASE_URL must be a valid absolute URL');
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    fail('TWILIO_WEBHOOK_BASE_URL must use http:// or https://');
  }
  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

const tunnelHostname = validateRegex(
  'TUNNEL_HOSTNAME',
  required('TUNNEL_HOSTNAME'),
  /^(?=.{1,253}$)(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))*$/,
  'a valid hostname'
);

const streamAuthSecret = required('STREAM_AUTH_SECRET');
if (streamAuthSecret.length < 32) {
  fail('STREAM_AUTH_SECRET must be at least 32 characters');
}

const statusApiToken = optional('STATUS_API_TOKEN');
if (!statusApiToken) {
  fail('Missing required env var: STATUS_API_TOKEN');
}
if (statusApiToken.length < 16) {
  fail('STATUS_API_TOKEN must be at least 16 characters');
}

const twilioWebhookBaseUrl = sanitizeBaseUrl(
  optional('TWILIO_WEBHOOK_BASE_URL') || `https://${tunnelHostname}`
);

module.exports = {
  port: parsePort('PORT', '8080'),
  tunnelHostname,
  twilioWebhookBaseUrl,
  twilioAccountSid: validateRegex(
    'TWILIO_ACCOUNT_SID',
    required('TWILIO_ACCOUNT_SID'),
    /^AC[a-zA-Z0-9]{32}$/,
    'AC followed by 32 alphanumeric chars'
  ),
  twilioAuthToken: required('TWILIO_AUTH_TOKEN'),
  twilioPhoneNumber: validateRegex(
    'TWILIO_PHONE_NUMBER',
    required('TWILIO_PHONE_NUMBER'),
    /^\+[1-9]\d{1,14}$/,
    'E.164 format (e.g. +15551234567)'
  ),
  hapUsername: validateRegex(
    'HAP_USERNAME',
    required('HAP_USERNAME'),
    /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/,
    'MAC-style uppercase hex (AA:BB:CC:DD:EE:FF)'
  ),
  hapPincode: validateRegex(
    'HAP_PINCODE',
    required('HAP_PINCODE'),
    /^\d{3}-\d{2}-\d{3}$/,
    'XXX-XX-XXX'
  ),
  hapPort: parsePort('HAP_PORT', '47129'),
  streamAuthSecret,
  streamAuthTtlSec: 90,
  statusApiToken,
};
