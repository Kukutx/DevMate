'use strict';

const DEFAULT_PORT = 8787;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

function portError(label, value) {
  const error = new Error(`${label} must be an integer from ${MIN_PORT} to ${MAX_PORT}; received ${String(value)}`);
  error.code = 'DEVMATE_PORT_INVALID';
  error.value = value;
  error.minimum = MIN_PORT;
  error.maximum = MAX_PORT;
  return error;
}

function strictPort(value, { fallback = DEFAULT_PORT, label = 'port' } = {}) {
  const candidate = value === undefined || value === null || value === '' ? fallback : value;
  if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < MIN_PORT || candidate > MAX_PORT) {
    throw portError(label, candidate);
  }
  return candidate;
}

function parsePortOption(value, { fallback = DEFAULT_PORT, label = '--port' } = {}) {
  if (value === undefined || value === null || value === '') return strictPort(fallback, { label });
  if (typeof value === 'number') return strictPort(value, { label });
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) throw portError(label, value);
  return strictPort(Number(value.trim()), { label });
}

module.exports = {
  DEFAULT_PORT,
  MAX_PORT,
  MIN_PORT,
  parsePortOption,
  strictPort
};
