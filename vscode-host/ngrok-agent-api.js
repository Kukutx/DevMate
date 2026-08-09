'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const defaultChildProcess = require('node:child_process');

const DEFAULT_NGROK_AGENT_API_BASE = 'http://127.0.0.1:4040/api';
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
  if (parsed.protocol !== 'http:') return DEFAULT_NGROK_AGENT_API_BASE;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const wildcard = hostname === '0.0.0.0' || hostname === '::';
  if (!loopback && !wildcard) return DEFAULT_NGROK_AGENT_API_BASE;
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

function upstreamMatchesPort(value, port) {
  const target = Number(port);
  if (!Number.isInteger(target) || target <= 0) return false;
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^\d+$/.test(raw)) return Number(raw) === target;
  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const parsedPort = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    return parsedPort === target;
  } catch {
    return Number(raw.match(/:(\d+)(?:\/)?$/)?.[1]) === target;
  }
}

function discoverNgrokPublicUrl(port, {
  apiBase = DEFAULT_NGROK_AGENT_API_BASE,
  request = http.request,
  timeoutMs = 1000
} = {}) {
  if (!apiBase) return Promise.resolve('');
  const endpointUrl = `${String(apiBase).replace(/\/$/, '')}/endpoints`;
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value || '');
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
            finish('');
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          if (settled || response.statusCode !== 200) return finish('');
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const match = (payload?.endpoints || []).find(item =>
              upstreamMatchesPort(item?.upstream?.url, port) && String(item?.url || '').startsWith('https://')
            );
            finish(match?.url || '');
          } catch {
            finish('');
          }
        });
      });
      req.on('error', () => finish(''));
      req.setTimeout(Math.max(250, Number(timeoutMs) || 1000), () => {
        req.destroy();
        finish('');
      });
      req.end();
    } catch {
      finish('');
    }
  });
}

module.exports = {
  DEFAULT_NGROK_AGENT_API_BASE,
  MAX_NGROK_AGENT_RESPONSE_BYTES,
  configPathFromCheckOutput,
  discoverNgrokPublicUrl,
  loopbackAgentApiBase,
  ngrokWebAddrFromConfig,
  resolveNgrokAgentApiBase,
  upstreamMatchesPort,
  yamlScalar
};
