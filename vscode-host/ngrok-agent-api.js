'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const defaultChildProcess = require('node:child_process');

const DEFAULT_NGROK_AGENT_API_BASE = 'http://127.0.0.1:4040/api';
const MAX_NGROK_AGENT_RESPONSE_BYTES = 64 * 1024;
const NGROK_CONFIG_CHECK_TIMEOUT_MS = 3000;

function yamlScalar(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const quoted = raw.match(/^(['"])(.*)\1\s*(?:#.*)?$/);
  if (quoted) return quoted[2].trim();
  return raw.replace(/\s+#.*$/, '').trim();
}

function ngrokWebAddrFromConfig(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const version3 = lines.some(line => /^\s*version\s*:\s*["']?3["']?\s*(?:#.*)?$/i.test(line));
  if (!version3) return null;

  let agentIndent = -1;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.match(/^\s*/)?.[0].length || 0;
    if (agentIndent < 0) {
      if (/^\s*agent\s*:\s*(?:#.*)?$/i.test(line)) agentIndent = indent;
      continue;
    }
    if (indent <= agentIndent) break;
    const match = line.match(/^\s*web_addr\s*:\s*(.*?)\s*$/i);
    if (match) return yamlScalar(match[1]);
  }
  return null;
}

function loopbackAgentApiBase(webAddr) {
  if (webAddr == null || webAddr === '') return DEFAULT_NGROK_AGENT_API_BASE;
  const value = String(webAddr).trim();
  if (/^(?:false|off|no)$/i.test(value)) return '';

  let parsed;
  try {
    parsed = new URL(value.includes('://') ? value : `http://${value}`);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:') return '';
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const wildcard = hostname === '0.0.0.0' || hostname === '::';
  if (!loopback && !wildcard) return '';
  const host = hostname.includes(':') ? '[::1]' : '127.0.0.1';
  const port = parsed.port || '4040';
  return `http://${host}:${port}/api`;
}

function configPathFromCheckOutput(output) {
  const text = String(output || '').replace(/\r/g, '');
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    const phrase = line.match(/(?:valid\s+)?configuration\s+file(?:\s+is|\s+at|\s*:)?\s+(.+)$/i);
    if (phrase) {
      const candidate = phrase[1].trim().replace(/^['"]|['"]$/g, '');
      if (/\.ya?ml$/i.test(candidate)) return candidate;
    }
  }
  for (const line of lines) {
    const windows = line.match(/([A-Za-z]:\\[^\r\n]+?\.ya?ml)\b/i);
    if (windows) return windows[1].trim().replace(/^['"]|['"]$/g, '');
    const posix = line.match(/(\/[^\r\n]+?\.ya?ml)\b/i);
    if (posix) return posix[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return '';
}

function resolveNgrokAgentApiBase(command = 'ngrok', {
  spawnSync = defaultChildProcess.spawnSync,
  readFile = fs.readFileSync,
  env = process.env,
  timeoutMs = NGROK_CONFIG_CHECK_TIMEOUT_MS
} = {}) {
  let check;
  try {
    check = spawnSync(command, ['config', 'check'], { encoding: 'utf8', windowsHide: true, env, timeout: Math.max(500, Math.min(5000, Number(timeoutMs) || NGROK_CONFIG_CHECK_TIMEOUT_MS)) });
  } catch {
    return DEFAULT_NGROK_AGENT_API_BASE;
  }
  if (!check || check.error || check.status !== 0) return DEFAULT_NGROK_AGENT_API_BASE;
  const configFile = configPathFromCheckOutput(`${check.stdout || ''}\n${check.stderr || ''}`);
  if (!configFile) return DEFAULT_NGROK_AGENT_API_BASE;
  try {
    const text = readFile(path.resolve(configFile), 'utf8');
    return loopbackAgentApiBase(ngrokWebAddrFromConfig(text));
  } catch {
    return DEFAULT_NGROK_AGENT_API_BASE;
  }
}

function loopbackUpstreamHost(hostname) {
  const value = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (value === 'localhost' || value === '::1') return true;
  if (!/^127(?:\.\d{1,3}){3}$/.test(value)) return false;
  const octets = value.split('.').map(Number);
  return octets.length === 4 && octets.every(part => Number.isInteger(part) && part >= 0 && part <= 255);
}

function upstreamMatchesPort(value, port) {
  const target = Number(port);
  if (!Number.isInteger(target) || target <= 0) return false;
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^\d+$/.test(raw)) return Number(raw) === target;
  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (parsed.protocol !== 'http:' || !loopbackUpstreamHost(parsed.hostname)) return false;
    return Number(parsed.port || 80) === target;
  } catch {
    return false;
  }
}

function normalizedPublicUrl(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function endpointPublicUrl(item) {
  return normalizedPublicUrl(item?.url || '');
}

function endpointUpstreamUrl(item) {
  return String(item?.upstream?.url || '').trim();
}

function collectionItems(payload) {
  return Array.isArray(payload?.endpoints) ? payload.endpoints : [];
}

function requestAgentEndpoints(apiBase, {
  request = http.request,
  timeoutMs = 1000
} = {}) {
  const endpointUrl = `${String(apiBase).replace(/\/$/, '')}/endpoints`;
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value || null);
    };
    let req;
    try {
      req = request(endpointUrl, { method: 'GET' }, response => {
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          if (settled) return;
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_NGROK_AGENT_RESPONSE_BYTES) {
            response.destroy();
            finish(null);
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          if (settled || response.statusCode !== 200) return finish(null);
          try {
            finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            finish(null);
          }
        });
      });
      req.on('error', () => finish(null));
      req.setTimeout(Math.max(100, Number(timeoutMs) || 1000), () => {
        req.destroy();
        finish(null);
      });
      req.end();
    } catch {
      finish(null);
    }
  });
}

async function discoverNgrokPublicUrl(port, {
  apiBase = DEFAULT_NGROK_AGENT_API_BASE,
  request = http.request,
  timeoutMs = 1000,
  expectedUrl = ''
} = {}) {
  if (!apiBase) return '';
  const expected = normalizedPublicUrl(expectedUrl);
  const payload = await requestAgentEndpoints(apiBase, { request, timeoutMs });
  const match = collectionItems(payload).find(item => {
    const url = endpointPublicUrl(item);
    return upstreamMatchesPort(endpointUpstreamUrl(item), port) &&
      url.startsWith('https://') &&
      (!expected || url === expected);
  });
  return match ? endpointPublicUrl(match) : '';
}

async function discoverLocalNgrokEndpoint(port, {
  apiBase = DEFAULT_NGROK_AGENT_API_BASE,
  request = http.request,
  timeoutMs = 350,
  expectedUrl = ''
} = {}) {
  if (!apiBase) return null;
  const normalizedApiBase = String(apiBase).replace(/\/$/, '');
  const publicUrl = await discoverNgrokPublicUrl(port, {
    apiBase: normalizedApiBase,
    request,
    timeoutMs: Math.max(100, Math.min(1000, Number(timeoutMs) || 350)),
    expectedUrl
  });
  return publicUrl ? { publicUrl, apiBase: normalizedApiBase } : null;
}

async function discoverLocalNgrokPublicUrl(port, options = {}) {
  const endpoint = await discoverLocalNgrokEndpoint(port, options);
  return endpoint?.publicUrl || '';
}

module.exports = {
  DEFAULT_NGROK_AGENT_API_BASE,
  MAX_NGROK_AGENT_RESPONSE_BYTES,
  NGROK_CONFIG_CHECK_TIMEOUT_MS,
  collectionItems,
  configPathFromCheckOutput,
  discoverLocalNgrokEndpoint,
  discoverLocalNgrokPublicUrl,
  discoverNgrokPublicUrl,
  endpointPublicUrl,
  endpointUpstreamUrl,
  loopbackAgentApiBase,
  loopbackUpstreamHost,
  ngrokWebAddrFromConfig,
  resolveNgrokAgentApiBase,
  upstreamMatchesPort,
  yamlScalar
};
