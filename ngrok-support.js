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

function copyEnvWithoutKey(env, name) {
  const wanted = String(name || '').toLowerCase();
  const next = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (key.toLowerCase() !== wanted) next[key] = value;
  }
  return next;
}

function buildNgrokSpawnOptions(options, { authtoken = '', useManagedAccount = true } = {}) {
  const next = { ...(options || {}) };
  const baseEnv = options?.env || process.env;

  if (!useManagedAccount) {
    // Machine mode means exactly that: inherit the user's normal ngrok environment,
    // including NGROK_AUTHTOKEN when they configured ngrok that way.
    next.env = { ...baseEnv };
    return next;
  }

  next.env = copyEnvWithoutKey(baseEnv, 'NGROK_AUTHTOKEN');
  const token = String(authtoken || '').trim();
  if (!token) throw new Error('DevMate-managed ngrok account requires an Authtoken.');
  next.env.NGROK_AUTHTOKEN = token;
  return next;
}

function parseNgrokVersion(value) {
  const text = String(value || '').trim();
  const match = text.match(/\bngrok(?:\s+version)?\s+v?(\d+)\.(\d+)\.(\d+)/i) ||
    text.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return { major, minor, patch, version: `${major}.${minor}.${patch}` };
}

function supportsNgrokEndpointsApi(value) {
  const version = typeof value === 'object' && value ? value : parseNgrokVersion(value);
  if (!version) return false;
  return version.major > 3 || (version.major === 3 && version.minor >= 30);
}

function redactNgrokOutput(value, secrets = []) {
  let text = String(value || '');
  for (const secret of secrets) {
    const token = String(secret || '');
    if (token.length >= 4) text = text.split(token).join('[REDACTED]');
  }
  return text
    .replace(/(NGROK_AUTHTOKEN\s*=\s*)[^\s]+/ig, '$1[REDACTED]')
    .replace(/((?:your\s+)?authtoken\s*:\s*)[^\s,;]+/ig, '$1[REDACTED]')
    .replace(/(authtoken\s+(?:is|was)\s+)[^\s,;]+/ig, '$1[REDACTED]');
}

function extractNgrokConflictUrl(text) {
  const value = String(text || '');
  const patterns = [
    /The endpoint\s+[\x60'"]?(https:\/\/[^\s\x60'"]+)[\x60'"]?\s+is already online/i,
    /endpoint\s+[\x60'"]?(https:\/\/[^\s\x60'"]+)[\x60'"]?[^\n]{0,120}already online/i
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match?.[1]) continue;
    const candidate = match[1].replace(/[),.;]+$/, '');
    try { return normalizeNgrokUrl(candidate); } catch {}
  }
  return '';
}

function classifyNgrokError(text) {
  const value = String(text || '');
  const code = value.match(/ERR_NGROK_\d+/i)?.[0]?.toUpperCase() || '';

  if (code === 'ERR_NGROK_334' || /endpoint.+already online/i.test(value)) {
    return {
      kind: 'endpoint-conflict',
      code: code || 'ERR_NGROK_334',
      publicUrl: extractNgrokConflictUrl(value)
    };
  }
  if (/authtoken|authentication failed|not authorized|unauthori[sz]ed/i.test(value) || /^ERR_NGROK_10[5-9]$/i.test(code)) {
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
  copyEnvWithoutKey,
  extractNgrokConflictUrl,
  isNgrokExecutable,
  isNgrokHttpArgs,
  normalizeNgrokUrl,
  parseNgrokVersion,
  redactNgrokOutput,
  supportsNgrokEndpointsApi,
  validateAuthtoken
};
