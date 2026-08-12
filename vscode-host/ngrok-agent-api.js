'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const defaultChildProcess = require('node:child_process');

const DEFAULT_NGROK_AGENT_API_BASE = 'http://127.0.0.1:4040/api';
const DEFAULT_NGROK_AGENT_SCAN_FIRST_PORT = 4040;
const DEFAULT_NGROK_AGENT_SCAN_LAST_PORT = 4050;
const MAX_NGROK_AGENT_RESPONSE_BYTES = 64 * 1024;

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
  if (!version3) {
    for (const line of lines) {
      const match = line.match(/^web_addr\s*:\s*(.*?)\s*$/i);
      if (match) return yamlScalar(match[1]);
    }
    return null;
  }

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
    return DEFAULT_NGROK_AGENT_API_BASE;
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
  env = process.env
} = {}) {
  let check;
  try {
    check = spawnSync(command, ['config', 'check'], { encoding: 'utf8', windowsHide: true, env });
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

function loopbackUpstreamPort(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) {
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
  }
  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (parsed.protocol !== 'http:' || !loopbackUpstreamHost(parsed.hostname)) return 0;
    const port = Number(parsed.port || 80);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
  } catch {
    return 0;
  }
}

function normalizedPublicUrl(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function endpointPublicUrl(item) {
  return normalizedPublicUrl(item?.url || item?.public_url || item?.publicUrl || '');
}

function endpointUpstreamUrl(item) {
  return String(
    item?.upstream?.url ||
    item?.upstream?.uri ||
    item?.upstream?.addr ||
    item?.upstream_url ||
    item?.upstreamUrl ||
    item?.forwards_to ||
    item?.forwardsTo ||
    item?.config?.addr ||
    item?.config?.upstream ||
    ''
  ).trim();
}

function collectionItems(payload, resource) {
  if (resource === 'endpoints') return Array.isArray(payload?.endpoints) ? payload.endpoints : [];
  if (resource === 'tunnels') return Array.isArray(payload?.tunnels) ? payload.tunnels : [];
  return [];
}

function requestAgentCollection(apiBase, resource, {
  request = http.request,
  timeoutMs = 1000
} = {}) {
  const endpointUrl = `${String(apiBase).replace(/\/$/, '')}/${resource}`;
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

function endpointIdentity(item, resource) {
  const value = resource === 'tunnels'
    ? (item?.name || item?.id || '')
    : (item?.id || item?.name || '');
  return String(value || '').trim();
}

function requestAgentDelete(apiBase, resource, identity, {
  request = http.request,
  timeoutMs = 1000
} = {}) {
  const value = String(identity || '').trim();
  if (!value) return Promise.resolve(false);
  const endpointUrl = `${String(apiBase).replace(/\/$/, '')}/${resource}/${encodeURIComponent(value)}`;
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value === true);
    };
    let req;
    try {
      req = request(endpointUrl, { method: 'DELETE' }, response => {
        response.on?.('data', () => {});
        response.on?.('end', () => finish([200, 202, 204, 404].includes(Number(response.statusCode))));
      });
      req.on?.('error', () => finish(false));
      req.setTimeout?.(Math.max(100, Number(timeoutMs) || 1000), () => {
        req.destroy?.();
        finish(false);
      });
      req.end();
    } catch {
      finish(false);
    }
  });
}

function probeDevMateGateway(port, {
  request = http.request,
  timeoutMs = 500
} = {}) {
  const target = Number(port);
  if (!Number.isInteger(target) || target <= 0 || target > 65535) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const chunks = [];
    let bytes = 0;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value === true);
    };
    let req;
    try {
      req = request(`http://127.0.0.1:${target}/control/health`, { method: 'GET' }, response => {
        response.on?.('data', chunk => {
          if (settled) return;
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > 16 * 1024) {
            response.destroy?.();
            finish(false);
            return;
          }
          chunks.push(buffer);
        });
        response.on?.('end', () => {
          if (settled || Number(response.statusCode) !== 200) return finish(false);
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(body?.name === 'devmate');
          } catch {
            finish(false);
          }
        });
      });
      req.on?.('error', () => finish(false));
      req.setTimeout?.(Math.max(100, Number(timeoutMs) || 500), () => {
        req.destroy?.();
        finish(false);
      });
      req.end();
    } catch {
      finish(false);
    }
  });
}

function localAgentApiBases(preferredApiBase = DEFAULT_NGROK_AGENT_API_BASE, {
  firstPort = DEFAULT_NGROK_AGENT_SCAN_FIRST_PORT,
  lastPort = DEFAULT_NGROK_AGENT_SCAN_LAST_PORT
} = {}) {
  const bases = [];
  const add = value => {
    const raw = String(value || '').trim().replace(/\/$/, '');
    if (!raw) return;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'http:' || !loopbackUpstreamHost(parsed.hostname)) return;
      const normalized = `http://127.0.0.1:${parsed.port || '80'}${parsed.pathname.replace(/\/$/, '') || '/api'}`;
      if (!bases.includes(normalized)) bases.push(normalized);
    } catch {}
  };
  add(preferredApiBase);
  const start = Math.max(1, Math.min(65535, Number(firstPort) || DEFAULT_NGROK_AGENT_SCAN_FIRST_PORT));
  const end = Math.max(start, Math.min(65535, Number(lastPort) || DEFAULT_NGROK_AGENT_SCAN_LAST_PORT));
  for (let port = start; port <= end; port += 1) add(`http://127.0.0.1:${port}/api`);
  return bases;
}

async function localNgrokEndpointCandidates(port, {
  apiBase = DEFAULT_NGROK_AGENT_API_BASE,
  request = http.request,
  timeoutMs = 1000,
  includeTarget = false
} = {}) {
  if (!apiBase) return [];
  const target = Number(port);
  const resources = ['tunnels', 'endpoints'];
  const collected = [];
  for (const resource of resources) {
    const payload = await requestAgentCollection(apiBase, resource, { request, timeoutMs });
    const items = collectionItems(payload, resource);
    for (const item of items) {
      const upstreamPort = loopbackUpstreamPort(endpointUpstreamUrl(item));
      const publicUrl = endpointPublicUrl(item);
      const identity = endpointIdentity(item, resource);
      if (!identity || !publicUrl.startsWith('https://') || !upstreamPort || (!includeTarget && upstreamPort === target)) continue;
      collected.push({ resource, identity, publicUrl, upstreamPort, apiBase: String(apiBase).replace(/\/$/, '') });
    }
    if (collected.length && resource === 'tunnels') break;
  }
  const unique = new Map();
  for (const item of collected) {
    const key = `${item.publicUrl}|${item.upstreamPort}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

async function localNgrokEndpointCandidatesAcrossAgents(port, {
  apiBase = DEFAULT_NGROK_AGENT_API_BASE,
  request = http.request,
  timeoutMs = 350,
  firstPort = DEFAULT_NGROK_AGENT_SCAN_FIRST_PORT,
  lastPort = DEFAULT_NGROK_AGENT_SCAN_LAST_PORT
} = {}) {
  const bases = localAgentApiBases(apiBase, { firstPort, lastPort });
  const groups = await Promise.all(bases.map(base => localNgrokEndpointCandidates(port, {
    apiBase: base,
    request,
    timeoutMs: Math.max(100, Math.min(500, Number(timeoutMs) || 350)),
    includeTarget: true
  })));
  const unique = new Map();
  for (const item of groups.flat()) {
    const key = `${item.publicUrl}|${item.upstreamPort}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

async function stopConflictingLocalNgrokEndpoints(port, {
  apiBase = DEFAULT_NGROK_AGENT_API_BASE,
  request = http.request,
  timeoutMs = 1000,
  firstPort = DEFAULT_NGROK_AGENT_SCAN_FIRST_PORT,
  lastPort = DEFAULT_NGROK_AGENT_SCAN_LAST_PORT
} = {}) {
  const boundedTimeout = Math.max(100, Math.min(500, Number(timeoutMs) || 350));
  const candidates = await localNgrokEndpointCandidatesAcrossAgents(port, {
    apiBase,
    request,
    timeoutMs: boundedTimeout,
    firstPort,
    lastPort
  });
  if (!candidates.length) return { stopped: 0, candidates: 0, ambiguous: false, endpoints: [] };

  const verification = await Promise.all(candidates.map(async candidate => ({
    candidate,
    verified: await probeDevMateGateway(candidate.upstreamPort, {
      request,
      timeoutMs: Math.min(350, boundedTimeout)
    })
  })));
  const verified = verification.filter(item => item.verified).map(item => item.candidate);
  const selected = verified.length ? verified : (candidates.length === 1 ? candidates : []);
  if (!selected.length) {
    return { stopped: 0, candidates: candidates.length, ambiguous: true, endpoints: candidates };
  }

  const deletion = await Promise.all(selected.map(async candidate => ({
    candidate,
    ok: await requestAgentDelete(candidate.apiBase || apiBase, candidate.resource, candidate.identity, {
      request,
      timeoutMs: boundedTimeout
    })
  })));
  const stopped = deletion.filter(item => item.ok).map(item => item.candidate);
  return {
    stopped: stopped.length,
    candidates: candidates.length,
    ambiguous: false,
    endpoints: stopped
  };
}

async function discoverNgrokPublicUrl(port, {
  apiBase = DEFAULT_NGROK_AGENT_API_BASE,
  request = http.request,
  timeoutMs = 1000,
  expectedUrl = ''
} = {}) {
  if (!apiBase) return '';
  const expected = normalizedPublicUrl(expectedUrl);
  for (const resource of ['endpoints', 'tunnels']) {
    const payload = await requestAgentCollection(apiBase, resource, { request, timeoutMs });
    const match = collectionItems(payload, resource).find(item => {
      const url = endpointPublicUrl(item);
      return upstreamMatchesPort(endpointUpstreamUrl(item), port) &&
        url.startsWith('https://') &&
        (!expected || url === expected);
    });
    if (match) return endpointPublicUrl(match);
  }
  return '';
}

async function discoverLocalNgrokEndpoint(port, {
  apiBase = DEFAULT_NGROK_AGENT_API_BASE,
  request = http.request,
  timeoutMs = 350,
  expectedUrl = '',
  firstPort = DEFAULT_NGROK_AGENT_SCAN_FIRST_PORT,
  lastPort = DEFAULT_NGROK_AGENT_SCAN_LAST_PORT
} = {}) {
  if (!apiBase) return null;
  const boundedTimeout = Math.max(100, Math.min(500, Number(timeoutMs) || 350));
  const preferred = String(apiBase).replace(/\/$/, '');
  const direct = await discoverNgrokPublicUrl(port, {
    apiBase: preferred,
    request,
    timeoutMs: boundedTimeout,
    expectedUrl
  });
  if (direct) return { publicUrl: direct, apiBase: preferred };

  const bases = localAgentApiBases(preferred, { firstPort, lastPort }).filter(base => base !== preferred);
  const matches = await Promise.all(bases.map(async base => ({
    apiBase: base,
    publicUrl: await discoverNgrokPublicUrl(port, {
      apiBase: base,
      request,
      timeoutMs: boundedTimeout,
      expectedUrl
    })
  })));
  return matches.find(item => item.publicUrl) || null;
}

async function discoverLocalNgrokPublicUrl(port, options = {}) {
  const endpoint = await discoverLocalNgrokEndpoint(port, options);
  return endpoint?.publicUrl || '';
}

module.exports = {
  DEFAULT_NGROK_AGENT_API_BASE,
  DEFAULT_NGROK_AGENT_SCAN_FIRST_PORT,
  DEFAULT_NGROK_AGENT_SCAN_LAST_PORT,
  MAX_NGROK_AGENT_RESPONSE_BYTES,
  collectionItems,
  configPathFromCheckOutput,
  discoverLocalNgrokEndpoint,
  discoverLocalNgrokPublicUrl,
  discoverNgrokPublicUrl,
  endpointPublicUrl,
  endpointUpstreamUrl,
  localAgentApiBases,
  localNgrokEndpointCandidates,
  localNgrokEndpointCandidatesAcrossAgents,
  loopbackAgentApiBase,
  loopbackUpstreamHost,
  loopbackUpstreamPort,
  ngrokWebAddrFromConfig,
  probeDevMateGateway,
  requestAgentDelete,
  resolveNgrokAgentApiBase,
  stopConflictingLocalNgrokEndpoints,
  upstreamMatchesPort,
  yamlScalar
};