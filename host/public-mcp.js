'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');

const MCP_PATH = '/mcp';
const MCP_PROTOCOL_VERSION = '2026-07-28';
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
  return /\b(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|ETIMEDOUT|ENOTFOUND)\b|socket hang up|socket disconnected before secure TLS connection|timed?\s*out|error code:\s*1033/i.test(detail);
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
  if (kind === 'authentication') return 'The public endpoint rejected DevMate OAuth authorization. Re-authorize the MCP client or inspect the OAuth configuration.';
  if (kind === 'wrong-endpoint') return 'The public URL does not point to the DevMate MCP endpoint.';
  if (kind === 'stale-generation') return 'The connection changed while it was being checked. DevMate will verify the current connection.';
  return 'The public endpoint responded, but the MCP 2026 discovery or tool-call probe was invalid. Copy diagnostics for details.';
}

function retryDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requestMeta(clientName, clientVersion) {
  return {
    'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': {
      name: String(clientName || 'devmate-preflight'),
      version: String(clientVersion || '0')
    },
    'io.modelcontextprotocol/clientCapabilities': {}
  };
}

function protocolHeaders(method, name, authHeaders = {}) {
  return {
    ...authHeaders,
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    'mcp-method': method,
    ...(name ? { 'mcp-name': String(name) } : {})
  };
}

function mcpPayload(id, method, params, clientName, clientVersion) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...(params || {}),
      _meta: requestMeta(clientName, clientVersion)
    }
  };
}

function mcpProtocolError(label, response, mcpUrl, code) {
  const error = new Error(
    `${label} failed via ${redactUrl(mcpUrl)}. ` +
    `HTTP=${response.status || 'none'} error=${response.error || ''} body=${String(response.body || '').slice(0, 300)}`
  );
  error.code = code;
  error.response = response;
  return error;
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

  const discover = await postJson(
    mcpUrl,
    mcpPayload(1, 'server/discover', {}, clientName, clientVersion),
    { headers: protocolHeaders('server/discover', '', authHeaders), timeoutMs, request }
  );
  const discoverResult = discover.json?.result;
  const serverInfo = discoverResult?._meta?.['io.modelcontextprotocol/serverInfo'];
  if (
    !discover.ok || discover.json?.error || serverInfo?.name !== 'devmate' ||
    !Array.isArray(discoverResult?.supportedVersions) || !discoverResult.supportedVersions.includes(MCP_PROTOCOL_VERSION)
  ) {
    throw mcpProtocolError('MCP server/discover', discover, mcpUrl, 'DEVMATE_PUBLIC_MCP_DISCOVER_FAILED');
  }

  const tools = await postJson(
    mcpUrl,
    mcpPayload(2, 'tools/list', {}, clientName, clientVersion),
    { headers: protocolHeaders('tools/list', '', authHeaders), timeoutMs, request }
  );
  if (!tools.ok || tools.json?.error || !Array.isArray(tools.json?.result?.tools)) {
    throw mcpProtocolError('MCP tools/list', tools, mcpUrl, 'DEVMATE_PUBLIC_MCP_TOOLS_FAILED');
  }
  if (!tools.json.result.tools.some(tool => tool?.name === PREFLIGHT_PROBE_TOOL)) {
    const error = new Error(`MCP tools/list did not expose required probe tool ${PREFLIGHT_PROBE_TOOL}`);
    error.code = 'DEVMATE_PUBLIC_MCP_PROBE_TOOL_MISSING';
    error.response = tools;
    throw error;
  }

  const probe = await postJson(
    mcpUrl,
    mcpPayload(3, 'tools/call', { name: PREFLIGHT_PROBE_TOOL, arguments: {} }, clientName, clientVersion),
    { headers: protocolHeaders('tools/call', PREFLIGHT_PROBE_TOOL, authHeaders), timeoutMs, request }
  );
  const probeResult = probe.json?.result;
  const probeName = probeResult?.structuredContent?.name;
  if (!probe.ok || probe.json?.error || probeResult?.isError === true || probeName !== 'devmate') {
    throw mcpProtocolError('MCP tools/call probe', probe, mcpUrl, 'DEVMATE_PUBLIC_MCP_TOOL_CALL_FAILED');
  }

  return {
    publicOrigin,
    mcpUrl,
    protocolVersion: MCP_PROTOCOL_VERSION,
    supportedVersions: [...discoverResult.supportedVersions],
    toolCount: tools.json.result.tools.length,
    toolCallVerified: true,
    probeTool: PREFLIGHT_PROBE_TOOL,
    server: serverInfo
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
  mcpPayload,
  mcpUrlFor,
  normalizePublicOrigin,
  parseJsonPayload,
  postJson,
  preflightPublicMcp,
  protocolHeaders,
  publicMcpErrorKind,
  publicMcpErrorSummary,
  publicEndpointLookup,
  redactUrl,
  requestMeta,
  requestRaw,
  transientPublicMcpError
};
