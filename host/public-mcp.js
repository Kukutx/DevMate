'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');

const MCP_PATH = '/mcp';
const MCP_PROTOCOL_VERSION = '2025-03-26';
const PREFLIGHT_PROBE_TOOL = 'gateway_status';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const cloudflarePublicDns = new dns.Resolver();
cloudflarePublicDns.setServers(['1.1.1.1', '1.0.0.1']);

const defaultPublicResolver = {
  lookup: dns.lookup.bind(dns),
  resolve4(hostname, callback) {
    cloudflarePublicDns.resolve4(hostname, (error, addresses) => {
      if (!error && addresses?.length) {
        callback(null, addresses);
        return;
      }
      dns.resolve4(hostname, callback);
    });
  }
};

function normalizePublicOrigin(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Public MCP origin is required');
  const url = new URL(text);
  if (url.protocol !== 'https:') throw new Error('Public MCP origin must use HTTPS');
  if (url.username || url.password) throw new Error('Public MCP origin must not contain credentials');
  if (url.search || url.hash) throw new Error('Public MCP origin must not contain a query or fragment');
  if (url.pathname && url.pathname !== '/') throw new Error('Public MCP origin must not contain a path');
  return `https://${url.host}`;
}

function mcpUrlFor(publicOrigin) {
  return new URL(MCP_PATH, `${normalizePublicOrigin(publicOrigin)}/`).toString();
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function parseJsonPayload(text) {
  const body = String(text || '').trim();
  if (!body) return null;
  try { return JSON.parse(body); } catch {}

  // Streamable HTTP may respond as SSE. Use the first JSON data frame.
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { return JSON.parse(data); } catch {}
  }
  return null;
}

function publicEndpointLookup(hostname, options, callback, resolver = defaultPublicResolver) {
  if (!String(hostname || '').toLowerCase().endsWith('.trycloudflare.com')) {
    resolver.lookup(hostname, options, callback);
    return;
  }
  resolver.resolve4(hostname, (error, addresses) => {
    if (error || !addresses?.length) {
      callback(error || Object.assign(new Error(`No IPv4 address found for ${hostname}`), { code: 'ENOTFOUND' }));
      return;
    }
    if (typeof options === 'object' && options?.all) {
      callback(null, addresses.map(address => ({ address, family: 4 })));
      return;
    }
    callback(null, addresses[0], 4);
  });
}

function requestRaw(url, {
  method = 'GET',
  headers = {},
  body = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  transports = { http, https }
} = {}) {
  return new Promise(resolve => {
    let target;
    try { target = url instanceof URL ? url : new URL(url); }
    catch (error) {
      resolve({ ok: false, error: `bad url: ${error.message || error}` });
      return;
    }
    const transport = target.protocol === 'https:' ? transports.https : target.protocol === 'http:' ? transports.http : null;
    if (!transport?.request) {
      resolve({ ok: false, error: `unsupported protocol: ${target.protocol || '(missing)'}` });
      return;
    }

    const timeout = Math.max(250, Math.min(120000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    const limit = Math.max(1024, Math.min(16 * 1024 * 1024, Number(maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES));
    let settled = false;
    let request = null;
    let response = null;
    let timer = null;
    let bytes = 0;

    const finish = result => {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
      return true;
    };
    const abort = (error, extra = {}) => {
      if (!finish({ ok: false, error, bytes, maxResponseBytes: limit, ...extra })) return;
      try { response?.destroy(); } catch {}
      try { request?.destroy(); } catch {}
    };

    try {
      request = transport.request(target, { method, headers, lookup: publicEndpointLookup }, incoming => {
        response = incoming;
        const advertised = Number(incoming.headers?.['content-length']);
        if (Number.isFinite(advertised) && advertised > limit) {
          abort('response-too-large', { status: incoming.statusCode, contentLength: advertised });
          return;
        }
        const chunks = [];
        incoming.on('data', chunk => {
          if (settled) return;
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > limit) {
            abort('response-too-large', { status: incoming.statusCode });
            return;
          }
          chunks.push(buffer);
        });
        incoming.on('aborted', () => abort('response-aborted', { status: incoming.statusCode }));
        incoming.on('error', error => abort(error.message || String(error), { status: incoming.statusCode }));
        incoming.on('end', () => {
          if (settled) return;
          const text = Buffer.concat(chunks).toString('utf8');
          finish({
            ok: incoming.statusCode >= 200 && incoming.statusCode < 300,
            status: incoming.statusCode,
            headers: incoming.headers || {},
            body: text,
            json: parseJsonPayload(text),
            bytes,
            maxResponseBytes: limit
          });
        });
      });
    } catch (error) {
      finish({ ok: false, error: error.message || String(error), bytes, maxResponseBytes: limit });
      return;
    }

    timer = setTimeout(() => abort('timeout'), timeout);
    timer.unref?.();
    request.on('error', error => finish({ ok: false, error: error.message || String(error), bytes, maxResponseBytes: limit }));
    try {
      if (body != null) request.write(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
      request.end();
    } catch (error) {
      abort(error.message || String(error));
    }
  });
}

function postJson(url, payload, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, request = requestRaw } = {}) {
  return request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers
    },
    body: JSON.stringify(payload),
    timeoutMs
  });
}

function transientPublicMcpError(error) {
  const status = Number(error?.response?.status || 0);
  if (status >= 500 && status <= 599) return true;
  const detail = `${error?.response?.error || ''} ${error?.response?.body || ''} ${error?.message || ''}`;
  return /\b(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|ETIMEDOUT|ENOTFOUND)\b|socket hang up|timed?\s*out|error code:\s*1033/i.test(detail);
}

function publicMcpErrorKind(error) {
  const status = Number(error?.response?.status || 0);
  if (status === 401 || status === 403) return 'authentication';
  if (status === 404) return 'wrong-endpoint';
  if (status >= 500 && status <= 599) return 'temporary-network';
  if (error?.code === 'DEVMATE_PUBLIC_MCP_STALE_GENERATION') return 'stale-generation';
  if (error?.code === 'DEVMATE_STARTUP_LEASE_TIMEOUT') return 'temporary-network';
  return transientPublicMcpError(error) ? 'temporary-network' : 'protocol';
}

function connectionErrorSummary(error) {
  const code = String(error?.code || '');
  if (code.includes('PUBLIC_MCP') || error?.response) return publicMcpErrorSummary(error);
  const message = String(error?.message || error || '').replace(/\s+/g, ' ').trim();
  if (code === 'ENOENT' || /(?:not found|not recognized|cannot find).*(?:ngrok|cloudflared)|spawn .* ENOENT/i.test(message)) {
    return 'The selected connection helper is not installed. Open Connection Setup for the one-time install/configuration step.';
  }
  return message.length > 260 ? `${message.slice(0, 257)}...` : message || 'DevMate could not start the connection. Copy diagnostics for details.';
}

function publicMcpErrorSummary(error) {
  const kind = publicMcpErrorKind(error);
  if (kind === 'temporary-network') return 'The public endpoint is still becoming reachable. DevMate kept it running and will retry automatically.';
  if (kind === 'authentication') return 'The public endpoint rejected DevMate authentication. Check the connection token setting.';
  if (kind === 'wrong-endpoint') return 'The public URL does not point to the DevMate MCP endpoint.';
  if (kind === 'stale-generation') return 'The connection changed while it was being checked. DevMate will verify the current connection.';
  return 'The public endpoint responded, but the MCP handshake or tool-call probe was invalid. Copy diagnostics for details.';
}

function retryDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function preflightPublicMcpOnce({
  publicUrl,
  token = '',
  clientName = 'devmate-preflight',
  clientVersion = '0',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  request = requestRaw
} = {}) {
  const publicOrigin = normalizePublicOrigin(publicUrl);
  const mcpUrl = mcpUrlFor(publicOrigin);
  const authHeaders = String(token || '').trim()
    ? { authorization: `Bearer ${String(token).trim()}` }
    : {};

  const init = await postJson(mcpUrl, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: String(clientName || 'devmate-preflight'), version: String(clientVersion || '0') }
    }
  }, { headers: authHeaders, timeoutMs, request });

  const serverName = init.json?.result?.serverInfo?.name;
  if (!init.ok || serverName !== 'devmate') {
    const error = new Error(
      `MCP initialize failed via ${redactUrl(mcpUrl)}. Expected DevMate server, got ${serverName || 'none'}. ` +
      `HTTP=${init.status || 'none'} error=${init.error || ''} body=${String(init.body || '').slice(0, 300)}`
    );
    error.code = 'DEVMATE_PUBLIC_MCP_INITIALIZE_FAILED';
    error.response = init;
    throw error;
  }

  const sessionId = String(init.headers?.['mcp-session-id'] || '').trim();
  const requestHeaders = {
    ...authHeaders,
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {})
  };
  const tools = await postJson(mcpUrl, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  }, { headers: requestHeaders, timeoutMs, request });

  if (!tools.ok || !Array.isArray(tools.json?.result?.tools)) {
    const error = new Error(
      `MCP tools/list failed via ${redactUrl(mcpUrl)}. ` +
      `HTTP=${tools.status || 'none'} error=${tools.error || ''} body=${String(tools.body || '').slice(0, 300)}`
    );
    error.code = 'DEVMATE_PUBLIC_MCP_TOOLS_FAILED';
    error.response = tools;
    throw error;
  }

  if (!tools.json.result.tools.some(tool => tool?.name === PREFLIGHT_PROBE_TOOL)) {
    const error = new Error(`MCP tools/list did not expose required probe tool ${PREFLIGHT_PROBE_TOOL}`);
    error.code = 'DEVMATE_PUBLIC_MCP_PROBE_TOOL_MISSING';
    error.response = tools;
    throw error;
  }

  const probe = await postJson(mcpUrl, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: PREFLIGHT_PROBE_TOOL, arguments: {} }
  }, { headers: requestHeaders, timeoutMs, request });
  const probeResult = probe.json?.result;
  const probeName = probeResult?.structuredContent?.name;
  if (!probe.ok || probe.json?.error || probeResult?.isError === true || probeName !== 'devmate') {
    const error = new Error(
      `MCP tools/call probe failed via ${redactUrl(mcpUrl)}. ` +
      `HTTP=${probe.status || 'none'} error=${probe.error || ''} body=${String(probe.body || '').slice(0, 300)}`
    );
    error.code = 'DEVMATE_PUBLIC_MCP_TOOL_CALL_FAILED';
    error.response = probe;
    throw error;
  }

  return {
    publicOrigin,
    mcpUrl,
    sessionId: sessionId || null,
    toolCount: tools.json.result.tools.length,
    toolCallVerified: true,
    probeTool: PREFLIGHT_PROBE_TOOL,
    server: init.json.result.serverInfo
  };
}

async function preflightPublicMcp(options = {}) {
  const readyTimeoutMs = Math.max(0, Math.min(90000, Number(options.readyTimeoutMs) || 0));
  const retryDelayMs = Math.max(100, Math.min(2000, Number(options.retryDelayMs) || 500));
  const deadline = Date.now() + readyTimeoutMs;
  let attempt = 0;
  while (true) {
    if (typeof options.shouldContinue === 'function' && options.shouldContinue() !== true) {
      const error = new Error('Public MCP verification became stale before the endpoint was ready');
      error.code = 'DEVMATE_PUBLIC_MCP_STALE_GENERATION';
      throw error;
    }
    try {
      return await preflightPublicMcpOnce(options);
    } catch (error) {
      const remaining = deadline - Date.now();
      if (!readyTimeoutMs || remaining <= 0 || !transientPublicMcpError(error)) throw error;
      const backoff = Math.min(2000, retryDelayMs * (2 ** Math.min(3, attempt++)));
      await retryDelay(Math.min(backoff, remaining));
    }
  }
}

module.exports = {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  MCP_PATH,
  MCP_PROTOCOL_VERSION,
  PREFLIGHT_PROBE_TOOL,
  connectionErrorSummary,
  mcpUrlFor,
  normalizePublicOrigin,
  parseJsonPayload,
  postJson,
  preflightPublicMcp,
  publicMcpErrorKind,
  publicMcpErrorSummary,
  publicEndpointLookup,
  redactUrl,
  requestRaw,
  transientPublicMcpError
};
