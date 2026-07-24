'use strict';

function commandBase(command) {
  return String(command || '').trim().split(/[\\/]+/).pop().toLowerCase();
}

function isNgrokExecutable(command) {
  const base = commandBase(command);
  return base === 'ngrok' || base === 'ngrok.exe';
}

function normalizeNgrokUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(candidate);
  } catch (error) {
    throw new Error(`Invalid ngrok URL: ${error.message}`);
  }

  if (url.protocol !== 'https:') throw new Error('ngrok URL must use https://.');
  if (!url.hostname) throw new Error('ngrok URL must include a hostname.');
  if (url.username || url.password) throw new Error('ngrok URL must not include credentials.');
  if (url.search || url.hash) throw new Error('ngrok URL must not include a query string or fragment.');
  if (url.pathname && url.pathname !== '/') throw new Error('ngrok URL must not include a path.');

  return `https://${url.host}`;
}

function isNgrokHttpArgs(args) {
  return Array.isArray(args) && String(args[0] || '').toLowerCase() === 'http';
}

function hasFlag(args, names) {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  return args.some(arg => wanted.has(String(arg || '').toLowerCase().split('=')[0]));
}

function buildNgrokArgs(args, { url = '', poolingEnabled = false } = {}) {
  const next = Array.isArray(args) ? [...args] : [];
  if (!isNgrokHttpArgs(next)) return next;

  const normalizedUrl = normalizeNgrokUrl(url);
  if (normalizedUrl && !hasFlag(next, ['--url', '--domain', '--hostname'])) {
    next.push('--url', normalizedUrl);
  }
  if (poolingEnabled && !hasFlag(next, ['--pooling-enabled'])) {
    next.push('--pooling-enabled');
  }
  return next;
}

function buildNgrokSpawnOptions(options, { authtoken = '', useManagedAccount = true } = {}) {
  const next = { ...(options || {}) };
  const baseEnv = options?.env || process.env;
  next.env = { ...baseEnv };

  if (useManagedAccount) {
    const token = String(authtoken || '').trim();
    if (!token) throw new Error('DevMate-managed ngrok account requires an Authtoken.');
    next.env.NGROK_AUTHTOKEN = token;
  }
  return next;
}

function classifyNgrokError(text) {
  const value = String(text || '');
  const code = value.match(/ERR_NGROK_\d+/i)?.[0]?.toUpperCase() || '';

  if (code === 'ERR_NGROK_334' || /endpoint.+already online/i.test(value)) {
    return { kind: 'endpoint-conflict', code: code || 'ERR_NGROK_334' };
  }
  if (/authtoken|authentication failed|not authorized|unauthori[sz]ed/i.test(value) || /^ERR_NGROK_10(?:5|8)$/i.test(code)) {
    return { kind: 'authentication', code };
  }
  if (/domain.+(?:not found|not reserved|not available|does not belong)|failed to bind/i.test(value)) {
    return { kind: 'domain', code };
  }
  return null;
}

function validateAuthtoken(value) {
  const token = String(value || '').trim();
  if (!token) throw new Error('Authtoken is required.');
  if (/\s/.test(token)) throw new Error('Authtoken must not contain spaces.');
  if (token.length < 20) throw new Error('Authtoken looks too short. Copy the complete value from the ngrok dashboard.');
  return token;
}

module.exports = {
  buildNgrokArgs,
  buildNgrokSpawnOptions,
  classifyNgrokError,
  isNgrokExecutable,
  isNgrokHttpArgs,
  normalizeNgrokUrl,
  validateAuthtoken
};
