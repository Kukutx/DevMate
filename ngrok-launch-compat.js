'use strict';

const {
  isNgrokExecutable,
  isNgrokHttpArgs,
  validateAuthtoken
} = require('./ngrok-support');

function envValueCaseInsensitive(env, name) {
  const wanted = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(env || {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function hasAuthtokenFlag(args) {
  return (args || []).some(arg => {
    const value = String(arg || '').toLowerCase();
    return value === '--authtoken' || value.startsWith('--authtoken=');
  });
}

function buildCompatibleNgrokArgs(command, args, options, platform = process.platform) {
  const next = Array.isArray(args) ? [...args] : [];
  if (platform !== 'win32' || !isNgrokExecutable(command) || !isNgrokHttpArgs(next)) return next;

  const rawToken = envValueCaseInsensitive(options?.env, 'NGROK_AUTHTOKEN');
  if (rawToken == null || String(rawToken).trim() === '') return next;
  if (hasAuthtokenFlag(next)) return next;

  const token = validateAuthtoken(rawToken);
  next.push('--authtoken', token);
  return next;
}

function createNgrokCredentialCompatSpawn(nativeSpawn, platform = process.platform) {
  if (typeof nativeSpawn !== 'function') throw new TypeError('nativeSpawn must be a function');
  return function ngrokCredentialCompatSpawn(command, args, options) {
    const effectiveArgs = buildCompatibleNgrokArgs(command, args, options, platform);
    return nativeSpawn.call(this, command, effectiveArgs, options);
  };
}

module.exports = {
  buildCompatibleNgrokArgs,
  createNgrokCredentialCompatSpawn,
  envValueCaseInsensitive,
  hasAuthtokenFlag
};
