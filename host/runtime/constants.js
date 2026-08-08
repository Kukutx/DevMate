'use strict';

const packageJson = require('../../package.json');
const {
  MAX_CONFIG_BYTES,
  SUPPORTED_CONFIG_VERSION
} = require('../../shared/config-store.cjs');
const { DEFAULT_PORT } = require('../../shared/port.cjs');

const DEFAULT_VERSION = packageJson.version;
const DEFAULT_START_TIMEOUT_MS = 15000;
const MAX_HOST_CONTEXT_CHARS = 200000;

module.exports = {
  DEFAULT_PORT,
  DEFAULT_START_TIMEOUT_MS,
  DEFAULT_VERSION,
  MAX_CONFIG_BYTES,
  MAX_HOST_CONTEXT_CHARS,
  SUPPORTED_CONFIG_VERSION
};
