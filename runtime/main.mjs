import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createMcpServer } from './mcp.mjs';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { DevMateService } from './service.mjs';
import { DomainError } from './store.mjs';
import { VERSION, BUILD_ID } from './version.mjs';
import { createConnection } from './connection.mjs';
import { endQuickTunnel, keptQuickTunnel, quickTunnelKey } from './cloudflare-connection.mjs';
import { handleWorkbench } from './workbench.mjs';
import { publicMcpUrl, readConfig } from './config.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';
import { createEventStreams } from './event-stream.mjs';
import { writeAtomic } from './platform/atomic-write.mjs';
import { hardenExecutableSearch } from './platform/tools.mjs';
import { isProgram } from './platform/entry.mjs';
import { createOutboundProxy } from './platform/proxy.mjs';
import { clientSurfaceBy } from './surfaces.mjs';
import { VERIFY_CLIENT } from './connection-verify.mjs';
import { createChromeRegistration } from './platform/chrome-registration.mjs';
import { createClientRegistration } from './platform/client-registration.mjs';

const FORWARDED_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'true-client-ip'];
const WORKBENCH_PATHS = ['/', '/workbench', '/workbench/'];
const SESSION_LIMIT = 16;
const SIGN_IN_CODE_MS = 60_000;
const BODY_LIMIT = 16 * 1024 * 1024;
const REVERIFY_MS = 10 * 60_000;
const UPKEEP_MS = 60_000;
const LOG_LIMIT_BYTES = 8 * 1024 * 1024;
const STATUS = { unauthorized: 401, forbidden: 403, scope_mismatch: 403, invalid_origin: 403, not_found: 404, unknown_operation: 404,
  conflict: 409, operation_conflict: 409, body_too_large: 413, invalid_host: 421, forwarded_request: 421,
  runtime_stopping: 503, runtime_unavailable: 503 };
// What the runtime's own client of OpenAI's tunnel says with every call it hands to the ingress port.
const TUNNEL_HEADER = 'x-devmate-tunnel';
// Request headers an MCP client may send from a browser. Mcp-Param-* carries tool arguments by name.
const MCP_REQUEST_HEADER = /^(authorization|content-type|accept|last-event-id|mcp-[a-z0-9-]+)$/i;

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function failure(error) {
  const expected = error instanceof DomainError || error.name === 'ZodError' || typeof error.code === 'string';
  return { status: expected ? STATUS[error.code] || 400 : 500, body: { ok: false, error: {
    code: error.code || (error.name === 'ZodError' ? 'invalid_input' : 'internal_error'),
    message: error.message, ...(error.details ? { details: error.details } : {}) } } };
}
const refuse = (res, code, message) => { const { status, body } = failure(new DomainError(code, message)); send(res, status, body); };
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new DomainError('body_too_large', 'Request exceeds 16 MiB.');
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DomainError('invalid_input', 'Request body must be valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DomainError('invalid_input', 'Request must be a JSON object.');
  return parsed;
}
function equalSecret(a, b) {
  return typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
// Cloudflare does not carry event streams through a quick tunnel. Through one, every answer is a single JSON body,
// for clients of either protocol era: what a call reports while it runs is dropped, and long work is followed by
// asking again, as it is everywhere else. The SDK serves 2025 clients as streams only, so that leg is wired here.
function plainJsonHandler(factory, { maxRequestBodySize }) {
  // No subscription streams either: a stream that never ends would never arrive.
  const modern = createMcpHandler(factory, { legacy: 'reject', responseMode: 'json', maxSubscriptions: 0, maxRequestBodySize });
  return { close: modern.close, async fetch(request, extra = {}) {
    if (!await isLegacyRequest(request, extra.parsedBody, { maxRequestBodySize })) return modern.fetch(request, extra);
    if (request.method !== 'POST') return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, { status: 405 });
    const server = await factory({ authInfo: extra.authInfo, requestInfo: request });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize });
    await server.connect(transport);
    // A client that gave up stops the waiting; what the call started keeps running, as everywhere.
    const done = () => { transport.close().catch(() => {}); server.close().catch(() => {}); };
    request.signal?.addEventListener('abort', done, { once: true });
    try { return await transport.handleRequest(request, extra); }
    finally { done(); }
  } };
}

// Read or create the identity of an instance. Only the holder of the instance lock calls this, so there is
// no other writer. A file that is not an identity was cut short by a full disk or a kill, and is replaced.
function stableInstanceId(file) {
  let value = null;
  try { value = fs.readFileSync(file, 'utf8').trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (value !== null && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) return value;
  const candidate = randomUUID();
  writeAtomic(file, candidate);
  return candidate;
}
// Readers never observe a half-written file: write beside it, then rename over it.
const publish = writeAtomic;
// way: how the owner gets another port. (An editor knows this refusal by how it begins, and offers its own setting.)
function listen(listener, port, way) {
  return new Promise((resolve, reject) => {
    const failed = error => reject(error.code === 'EADDRINUSE'
      ? new DomainError('port_in_use', 'Port ' + port + ' on 127.0.0.1 is already used by another program. ' + way) : error);
    listener.once('error', failed);
    listener.listen({ host: '127.0.0.1', port }, () => { listener.off('error', failed); resolve(); });
  });
}

export async function startRuntime({ instanceRoot = path.join(os.homedir(), '.devmate', 'runtime'), port = 8788, ingressPort,
  adapterFactory, connectionFactory = createConnection, capabilitiesFactory, authOptions, onReady, proxy = null, programFile = fileURLToPath(import.meta.url) } = {}) {
  // A runtime keeps answering from memory when the folder it was started from is taken away under it, as an update
  // of an editor's extension does. What it starts from that folder later does not: the channel of a coding agent,
  // Claude Code's permission requests, the program a browser starts. Looked at whenever somebody asks how it is, and
  // said for as long as it is so, by every entry: it has to be started again.
  // (Gone is what the system says is not there. A file that cannot be asked about for another reason, a drive that
  // is away for a moment, is not said to have been removed by an update.)
  const filesGone = () => { try { fs.statSync(programFile); return false; } catch (error) { return error.code === 'ENOENT' || error.code === 'ENOTDIR'; } };
  instanceRoot = path.resolve(instanceRoot);
  fs.mkdirSync(instanceRoot, { recursive: true, mode: 0o700 });
  // The mode applies only when the directory is created. One that already existed is made private too:
  // on a shared computer the database inside it is otherwise readable by other accounts.
  if (process.platform !== 'win32') { try { fs.chmodSync(instanceRoot, 0o700); } catch {} }
  const generation = randomUUID();
  // Exactly one runtime owns an instance directory. Whoever loses this race has
  // touched nothing: not the identity, not the owner token, not the database, not the record.
  const identity = { pid: process.pid, generation };
  let lock;
  try { lock = await acquireInstanceLock(instanceRoot, identity); }
  catch (error) {
    if (error.code !== 'instance_running') throw error;
    throw Object.assign(new DomainError('instance_running', error.message), { owner: error.owner });
  }
  let instanceId;
  try { instanceId = identity.instanceId = stableInstanceId(path.join(instanceRoot, 'instance-id')); }
  catch (error) { await lock.close(); throw error; }
  const recordFile = path.join(instanceRoot, 'runtime.json'), tokenFile = path.join(instanceRoot, 'owner-token');
  // Whether the stop under way is one to start again after: said in a file beside the instance, just before, by the
  // launcher that asks for it. (Read once; a word older than two minutes is no word for this stop.)
  const restarting = () => { const file = path.join(instanceRoot, 'restarting'); try { const at = fs.statSync(file).mtimeMs; fs.rmSync(file, { force: true }); return Date.now() - at < 120000; } catch { return false; } };
  // A word left from a stop before (one this runtime's predecessor never read) is no word for this runtime's stop.
  try { fs.rmSync(path.join(instanceRoot, 'restarting'), { force: true }); } catch { /* the next stop reads only a fresh one */ }
  const token = randomBytes(32).toString('hex');
  let config;
  try {
    config = readConfig(instanceRoot);
    publish(tokenFile, token);
  } catch (error) { await lock.close(); throw error; }
  let stopping = false, stopPromise, connection, tunnelBeside, service, mcp, mcpHandler, plainMcp, plainHandler, streams, verifyTimer, upkeepTimer;
  // A browser tab gets a session of its own, bought with a single-use code that only
  // the holder of the owner token can mint. The owner token never leaves the
  // instance directory and is never handed to a browser. The session is no cookie:
  // a browser sends a cookie to every port of this host, so any other local web service
  // would receive it. The tab keeps its session to itself and presents it in a header.
  const sessions = new Set(), signInCodes = new Map();
  const health = { status: 'starting', name: 'DevMate', version: VERSION, instanceId, generation, buildId: BUILD_ID, pid: process.pid };
  const owner = req => {
    const authorization = req.headers.authorization || '';
    if (!authorization.startsWith('Bearer ')) return null;
    const presented = authorization.slice(7);
    return equalSecret(presented, token) ? 'token' : sessions.has(presented) ? 'session' : null;
  };
  // Two listeners, two trust levels. The control port is the owner's local
  // surface (workbench, CLI, editor hosts, local MCP clients). The ingress port
  // is what a tunnel or reverse proxy targets and serves only MCP and OAuth, so
  // no routing or Host-header mistake can expose the owner control interface.
  const publicUrl = publicMcpUrl(config);
  // A quick tunnel is given its address when its connector starts, and loses it when that ends: the origin public
  // requests must name is asked for each time, never remembered.
  const quickTunnel = config.connection.kind === 'cloudflare-quick';
  // A quick tunnel cannot ask for sign-in, and its host name is no secret: a name travels through DNS in the clear.
  // What keeps the endpoint the owner's is a path nobody can guess, that travels only inside TLS. It is made once and
  // kept in the instance, so that the address stays what the owner gave their client while the tunnel lives on (see
  // ./cloudflare-connection.mjs); the owner makes a new one at their computer (devmate connect quick --new-address).
  // A relay of the owner's own forwards one such path as well; there it is part of the configured address and stays.
  const mcpPath = quickTunnel ? '/mcp/' + quickTunnelKey(instanceRoot) : publicUrl ? new URL(publicUrl).pathname : '/mcp';
  const currentOrigin = () => {
    if (config.auth.mode === 'oauth') return config.auth.issuer;
    const url = publicUrl || (quickTunnel ? connection?.publicUrl?.() : null);
    return url ? new URL(url).origin : null;
  };
  const hasIngress = currentOrigin() !== null || quickTunnel || config.connection.kind === 'openai-tunnel';
  // The runtime's own client of OpenAI's tunnel is known at the ingress port by a secret of this start, which nothing
  // outside this process learns. Its loopback name alone says too little once a public route leads to the same port:
  // a proxy that rewrites Host to that name (nginx does unless told otherwise) would make every request from outside
  // the tunnel's.
  const tunnelSecret = randomBytes(32).toString('base64url');
  // The control port answers to this computer under any local port number: an editor that forwards it from a remote
  // machine reaches it as localhost:<another port>. Against DNS rebinding it is the name that counts, never the number.
  const localName = host => /^(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(host || '');
  const loopbackHost = (listener, host) => {
    const current = listener.address()?.port;
    return host === '127.0.0.1:' + current || host === 'localhost:' + current;
  };
  const guarded = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      const { status, body: content } = failure(error);
      // The log is read by devmate logs and goes into the report for a bug report: the path of an address that ends in
      // its key (a quick tunnel, a relay) is written without the key, in the request line and in what the fault says.
      if (status === 500) process.stderr.write((new Date().toISOString() + ' ' + req.method + ' ' + req.url.split('?')[0] + ': ' + (error.stack || error) + '\n').replace(/\/mcp\/[A-Za-z0-9_-]{20,}/g, '/mcp/<key>'));
      if (res.headersSent) { res.end(); return; }
      send(res, status, content);
    }
  };
  // tunnel: the request came through OpenAI's tunnel; proven where the runtime's own tunnel client handed it over.
  async function serveMcp(req, res, local, tunnel = null) {
    if (!mcp || stopping) return refuse(res, 'runtime_unavailable', 'Runtime is starting or stopping.');
    const cors = req.headers.origin ? { 'Access-Control-Allow-Origin': req.headers.origin, Vary: 'Origin',
      'Access-Control-Expose-Headers': 'WWW-Authenticate' } : {};
    if (req.method === 'OPTIONS') {
      const requested = String(req.headers['access-control-request-headers'] || '').split(',').map(name => name.trim()).filter(name => MCP_REQUEST_HEADER.test(name));
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Max-Age': '600',
        'Access-Control-Allow-Headers': [...new Set(['Authorization', 'Content-Type', 'Accept', 'Last-Event-ID', 'MCP-Protocol-Version', 'Mcp-Method', 'Mcp-Name', ...requested])].join(', ') });
      return res.end();
    }
    // The control port is reachable only from this computer, so a caller that
    // presents no credentials is its owner in either auth mode. A caller that
    // does present a token is exactly who that token says, or nobody. What the runtime's own tunnel client hands over
    // is the owner's in the same way: OpenAI lets a tunnel be used by the account it belongs to and by nobody else, and
    // no sign-in page can be reached through it.
    const { principal, reason } = (local || tunnel?.proven) && !req.headers.authorization ? { principal: { id: 'owner' }, reason: null } : service.auth.check(req);
    for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);
    if (!principal) {
      // The challenge tells a client where to sign in, and whether the token it sent was the problem.
      const challenge = service.auth.challenge(reason);
      if (challenge) res.setHeader('WWW-Authenticate', challenge);
      return refuse(res, 'unauthorized', reason || 'MCP authorization required.');
    }
    // The official Node adapter passes this verified identity to its per-request factory.
    // via: the way this request came, which connection_status tells the caller back.
    req.auth = { clientId: principal.id, scopes: ['devmate'], extra: { devmatePrincipal: principal, via: local ? 'local' : tunnel ? 'openai-tunnel' : 'address', ...(tunnel ? { tunnel: true } : {}) } };
    // The tunnel carries event streams; only the quick tunnel's own address does not.
    return await (plainMcp && !local && !tunnel ? plainMcp : mcp)(req, res);
  }
  const ingress = http.createServer(guarded(async (req, res) => {
    // An OpenAI tunnel client forwards to this loopback port itself; every other
    // route arrives through a proxy that preserves the configured public host.
    const loopback = loopbackHost(ingress, req.headers.host);
    const proven = loopback && equalSecret(req.headers[TUNNEL_HEADER], tunnelSecret);
    // OpenAI's own tunnel-client program cannot be told the secret. It is taken by the loopback name where the tunnel
    // is the only connection, and what it hands over is checked like every request from outside.
    const tunnelLocal = proven || (config.connection.kind === 'openai-tunnel' && loopback);
    const publicOrigin = currentOrigin();
    if (!tunnelLocal && (!publicOrigin || req.headers.host !== new URL(publicOrigin).host)) {
      // What usually brings a request here under another name is a proxy that does not pass the public one on. The
      // address itself is not said: without sign-in it is all that keeps a stranger out, and a page of any site can
      // be made to ask this port.
      const named = String(req.headers.host || '').replace(/[^\x21-\x7e]/g, '').slice(0, 120);
      // Where this DevMate has no public address (OpenAI's tunnel is the only connection, or a quick tunnel has not
      // been given its address yet) there is no proxy to speak of and no address that devmate mcp-url would show.
      return refuse(res, 'invalid_host', 'This request names the host ' + (named || '(none)') + (publicOrigin
        ? ', which is not the public address of this DevMate (devmate mcp-url shows it). A proxy in front of DevMate has to pass the public host name on: nginx "proxy_set_header Host $host;", Apache "ProxyPreserveHost On".'
        : '. This DevMate has no public address at the moment, so nothing is answered on this port under that name' + (config.connection.kind === 'cloudflare-quick' ? ' (the quick tunnel has not been given its address yet: try again in a few seconds).' : '.')));
    }
    const requestOrigin = tunnelLocal ? 'http://' + req.headers.host : publicOrigin;
    const url = new URL(req.url, requestOrigin);
    if (service?.auth && await service.auth.handle(req, res, url)) return;
    if (req.headers.origin && !new Set([requestOrigin, ...(config.allowedOrigins || [])]).has(req.headers.origin)) return refuse(res, 'invalid_origin', 'The origin ' + req.headers.origin + ' is not allowed. A browser-based client you run yourself is allowed by adding its origin to "allowedOrigins" in the DevMate configuration; on the local port such an origin acts as the owner.');
    // The key in a public address belongs to that address; the tunnel comes by the plain path.
    if (equalSecret(url.pathname, tunnelLocal ? '/mcp' : mcpPath)) return serveMcp(req, res, false, tunnelLocal ? { proven } : null);
    return refuse(res, 'not_found', 'Only MCP and OAuth routes are exposed through the public ingress.');
  }));
  function windowProject(req) {
    const windowId = req.headers['x-devmate-window-id'];
    return windowId ? { windowId, projectId: service.windows.get(windowId).selectedProjectId } : null;
  }
  const server = http.createServer(guarded(async (req, res) => {
    const requestHost = req.headers.host;
    if (!localName(requestHost)) return refuse(res, 'invalid_host', 'Unexpected host.');
    // A proxy in front of the control port means the owner surface is being published by mistake.
    if (FORWARDED_HEADERS.some(name => req.headers[name] !== undefined)) return refuse(res, 'forwarded_request', 'The local control port must not be published. Point the tunnel or proxy at the ingress port.');
    const requestOrigin = 'http://' + requestHost;
    const url = new URL(req.url, requestOrigin);
    if (url.pathname === '/health' && req.method === 'GET') return send(res, 200, filesGone() ? { ...health, filesGone: true } : health);
    const allowedOrigins = new Set([requestOrigin, ...(config.allowedOrigins || [])]);
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return refuse(res, 'invalid_origin', 'The origin ' + req.headers.origin + ' is not allowed. A browser-based client you run yourself is allowed by adding its origin to "allowedOrigins" in the DevMate configuration; on the local port such an origin acts as the owner.');
    if (url.pathname === '/mcp') return serveMcp(req, res, true);
    if (req.headers.origin && req.headers.origin !== requestOrigin) return refuse(res, 'invalid_origin', 'Use the local workbench origin.');
    if (!service || health.status === 'starting') return refuse(res, 'runtime_unavailable', 'Runtime is starting.');
    if (url.pathname === '/api/agent') {
      if (req.method !== 'POST') return refuse(res, 'invalid_input', 'POST required.');
      const agentToken = (req.headers.authorization || '').replace(/^Bearer /, '');
      const input = await body(req);
      return send(res, 200, { ok: true, result: await service.agents.channelCall(agentToken, input.name, input.input || {}) });
    }
    if (WORKBENCH_PATHS.includes(url.pathname) && ['GET', 'HEAD'].includes(req.method)) {
      if (req.headers['sec-fetch-site'] === 'cross-site') return refuse(res, 'invalid_origin', 'Open DevMate directly from its local URL.');
      // The page is the same for everyone and holds nothing: it signs in with what its own tab was given.
      if (await handleWorkbench(req, res)) return;
    }
    if (url.pathname === '/api/session/exchange' && req.method === 'POST') {
      // The page spends the single-use code of its link here. What it gets back never appears in a URL.
      const { code } = await body(req);
      const expiresAt = typeof code === 'string' ? signInCodes.get(code) : undefined;
      signInCodes.delete(code);
      if (!expiresAt || expiresAt < Date.now()) return refuse(res, 'unauthorized', 'This sign-in link has expired or was already used.');
      const session = randomBytes(32).toString('base64url');
      sessions.add(session);
      if (sessions.size > SESSION_LIMIT) sessions.delete(sessions.values().next().value);
      return send(res, 200, { ok: true, result: { session } });
    }
    const authenticated = owner(req);
    if (!authenticated) return refuse(res, 'unauthorized', 'Local owner authentication required.');
    // The command line, started by a connected client through its shell tool or by a delegated agent: it speaks
    // for that client, not for the owner at this computer.
    const viaClient = req.headers['x-devmate-via'] !== undefined;
    const local = viaClient ? {} : { surface: 'local' };
    if (url.pathname === '/api/session' && req.method === 'POST') {
      // Only the owner token mints browser sessions; a browser session cannot multiply itself.
      if (authenticated !== 'token' || viaClient) return refuse(res, 'forbidden', 'A workbench sign-in link is created by the owner at this computer.');
      for (const [code, expiresAt] of signInCodes) if (expiresAt < Date.now()) signInCodes.delete(code);
      const code = randomBytes(32).toString('base64url');
      signInCodes.set(code, Date.now() + SIGN_IN_CODE_MS);
      return send(res, 200, { ok: true, result: { url: requestOrigin + '/?code=' + code, expiresInSeconds: SIGN_IN_CODE_MS / 1000 } });
    }
    if (url.pathname === '/api/snapshot' && req.method === 'GET') {
      const scope = windowProject(req);
      if (scope && !scope.projectId) throw new DomainError('window_unselected', 'Select a project in this editor window.');
      const requestProject = url.searchParams.get('projectId') || undefined;
      if (scope && requestProject && requestProject !== scope.projectId) throw new DomainError('scope_mismatch', 'Project is outside this editor window.');
      return send(res, 200, { ok: true, result: await service.snapshot({
        projectId: scope?.projectId || requestProject, workflowId: url.searchParams.get('workflowId') || undefined
      }, { id: 'owner', ...local, ...(scope || {}) }) });
    }
    if (url.pathname === '/api/call' && req.method === 'POST') {
      const input = await body(req);
      if (typeof input.operation !== 'string' || !input.operation) throw new DomainError('invalid_input', 'operation must name a DevMate operation.');
      if (input.input !== undefined && (!input.input || typeof input.input !== 'object' || Array.isArray(input.input))) throw new DomainError('invalid_input', 'input must be a JSON object.');
      if (stopping && !['runtime.stop', 'host.record.get', 'host.record.put', 'host.record.list'].includes(input.operation)) return refuse(res, 'runtime_stopping', 'Runtime is stopping.');
      const context = { id: 'owner', ...local };
      // The browser host waits here for work. When it goes away unanswered (its browser was closed, or ended), the
      // link is told that nobody listens on it any more, instead of finding out when a call is not answered.
      if (input.operation === 'chrome.next') {
        const left = new AbortController();
        res.once('close', () => { if (!res.writableEnded) left.abort(); });
        context.signal = left.signal;
      }
      const windowId = req.headers['x-devmate-window-id'];
      if (windowId) {
        context.windowId = windowId;
        if (input.operation.startsWith('window.') && input.operation !== 'window.list') {
          if (input.input?.windowId !== windowId) throw new DomainError('scope_mismatch', 'A window may only manage its own binding.');
        } else {
          // An editor window acts on its own project. The service refuses a
          // project-bound operation from a window that has selected none.
          const selected = service.windows.get(windowId).selectedProjectId;
          if (selected) context.projectId = selected;
        }
      }
      return send(res, 200, { ok: true, result: await service.call(input.operation, input.input || {}, context) });
    }
    if (url.pathname === '/events' && req.method === 'GET') {
      if (stopping) return refuse(res, 'runtime_stopping', 'Runtime is stopping.');
      const scope = windowProject(req);
      if (scope && !scope.projectId) throw new DomainError('window_unselected', 'Select a project in this editor window.');
      const rawCursor = req.headers['last-event-id'] ?? url.searchParams.get('after');
      const after = rawCursor === undefined || rawCursor === null ? service.store.revision : Number(rawCursor);
      if (!Number.isSafeInteger(after) || after < 0) throw new DomainError('invalid_cursor', 'Event cursor must be a nonnegative safe integer.');
      streams.open(res, { after, projectId: scope?.projectId || null, headers: { 'X-DevMate-Generation': generation } });
      return;
    }
    refuse(res, 'not_found', 'Route not found.');
  }));

  // crashed: this runtime ends because something went wrong in it, not because it was told to. What it owns is
  // released all the same, and its record is left where it is: a record nobody holds is how every entry knows that a
  // runtime ended unexpectedly, and an editor that keeps one running starts another.
  const stop = (input = {}, { crashed = false } = {}) => {
    if (input.expectedGeneration && input.expectedGeneration !== generation) throw new DomainError('generation_mismatch', 'Runtime ownership changed.');
    if (stopPromise) return stopPromise;
    stopping = true; health.status = 'stopping';
    // The short delay lets the response to a runtime.stop request leave first.
    stopPromise = new Promise(resolve => setTimeout(resolve, 20)).then(async () => {
      clearTimeout(verifyTimer); clearInterval(upkeepTimer);
      streams?.close();
      // A runtime that stops in order to start again (a restart, an update; whoever asks for it says so beside the
      // instance, see ../launcher.mjs) leaves a quick tunnel running for the next one. One that failed does not: until
      // another runtime is started, which may be much later, the tunnel would forward the public address, key and all,
      // to a port nobody holds, and any program of this computer could take that port and be handed the owner's calls.
      const again = restarting(), keep = again;
      if (again) process.stderr.write(new Date().toISOString() + ' stopping to be started again: what lives on between two runtimes stays\n');
      const results = await Promise.allSettled([service?.close(), connection?.stop({ keep }), tunnelBeside?.stop(), mcpHandler?.close(), plainHandler?.close()]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Owned processes have not all confirmed shutdown; runtime ownership is retained.');
      const closing = [server, ingress].map(listener => {
        const closed = listener.listening ? new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve())) : Promise.resolve();
        // After all owned operations confirmed shutdown, close outstanding
        // streaming HTTP sockets that raced with the first SSE drain.
        listener.closeAllConnections();
        return closed;
      });
      await Promise.all(closing);
      // Remove only what this runtime published; a successor's files are not ours to touch.
      try { if (!crashed && JSON.parse(fs.readFileSync(recordFile, 'utf8')).generation === generation) fs.rmSync(recordFile, { force: true }); } catch {}
      try { if (fs.readFileSync(tokenFile, 'utf8') === token) fs.rmSync(tokenFile, { force: true }); } catch {}
      health.status = 'stopped';
      await lock.close();
    });
    stopPromise.catch(error => {
      health.status = 'shutdown_failed';
      health.shutdownError = error.message;
      stopPromise = undefined;
      process.stderr.write('DevMate shutdown: ' + error.message + '\n');
    });
    return stopPromise;
  };

  try {
    service = new DevMateService({ instanceRoot, endpoint: '', adapterFactory, config, capabilitiesFactory, authOptions,
      onStop: input => { void stop(input); } });
    service.filesGone = filesGone;
    await service.ready;
    streams = createEventStreams({ store: service.store });
    const requestedPort = port;
    const another = 'devmate start --port <number> (in an editor: its DevMate runtime port setting)';
    await listen(server, port, 'Start DevMate on another one: ' + another + '.');
    port = server.address().port;
    if (hasIngress) {
      const named = ingressPort ?? config.ingressPort;
      // A quick tunnel left running by the runtime before forwards to the port that one came in by: taken again where
      // it is free, so that the tunnel, and its address, can be taken back.
      const kept = quickTunnel && named == null ? keptQuickTunnel(instanceRoot)?.forwardsTo : undefined;
      let taken = false;
      if (Number.isInteger(kept) && kept >= 1024 && kept <= 65535 && kept !== port) { try { await listen(ingress, kept, ''); taken = true; } catch { /* the usual one, and a new tunnel */ } }
      if (!taken) await listen(ingress, named ?? (requestedPort ? requestedPort + 1 : 0), named ? 'It is the port the public connection comes in by, as ingressPort names it in config.json: name another one there.'
        : 'It is the port the public connection comes in by, the one after the runtime\'s. Start DevMate on another one: ' + another + ', or name a port for it as ingressPort in config.json.');
      ingressPort = ingress.address().port;
    } else ingressPort = null;
    service.agents.endpoint = 'http://127.0.0.1:' + port + '/api/agent';
    service.identity = { instanceId, generation };
    service.proxy = proxy;
    const reach = { instanceRoot, instanceId, env: service.secrets.environment(), localHeaders: { [TUNNEL_HEADER]: tunnelSecret } };
    connection = connectionFactory({ ...reach, config: config.connection || { kind: 'local' }, localMcpUrl: 'http://127.0.0.1:' + (ingressPort ?? port) + mcpPath });
    service.connection = connection;
    // OpenAI's tunnel beside the public route: a second way in to the same port, under the plain path.
    if (config.openaiTunnel) tunnelBeside = service.tunnel = connectionFactory({ ...reach, beside: true, config: { kind: 'openai-tunnel', ...config.openaiTunnel }, localMcpUrl: 'http://127.0.0.1:' + ingressPort + '/mcp' });
    // What a request says about its client and what it asks for decides which tool names it is shown (./surfaces.mjs):
    // read from the message before the SDK takes it, and carried to the factory that serves this very request.
    const asked = new AsyncLocalStorage();
    // A client of the 2025 protocol names itself once, when it begins, and its later requests carry its sender line
    // only. What a sender line last named itself is remembered, so that the tools it is shown stay those of its name.
    const named = new Map();
    const noting = handler => ({ close: handler.close, async fetch(request, extra = {}) {
      // Asking which tools there are, and saying who asks, are small messages; a large one is a call and is not read twice.
      let messages = [];
      if (request.method === 'POST' && !(Number(request.headers.get('content-length')) > 65536)) {
        try { messages = [extra.parsedBody ?? await request.clone().json()].flat().filter(message => message && typeof message === 'object'); } catch { /* the handler answers a malformed message */ }
      }
      const said = messages.map(message => message.params?._meta?.['io.modelcontextprotocol/clientInfo']?.name || message.params?.clientInfo?.name).find(Boolean);
      // Whether it came through OpenAI's tunnel was decided where it arrived (the ingress port).
      const sender = request.headers.get('user-agent'), tunnel = extra.authInfo?.extra?.tunnel === true;
      // (The runtime's own check of its route names itself and is no client: its name is not given to whoever else
      // sends the same line, such as a script on the plain Node user agent.)
      if (said && sender && said !== VERIFY_CLIENT) { named.delete(sender); named.set(sender, String(said).slice(0, 200)); if (named.size > 64) named.delete(named.keys().next().value); }
      const decided = clientSurfaceBy({ chosen: new URL(request.url).searchParams.get('tools'), name: said || (sender ? named.get(sender) : undefined), userAgent: sender, tunnel,
        local: extra.authInfo?.extra?.via === 'local' });
      // Who asked last and which tool names they were given, for the doctor. What a client says of itself is its own
      // text: kept short and printable. A client of the 2025 protocol names itself once; its later requests keep that
      // name while the sender line stays the same. The check of the public route asks as itself and is not a client.
      // Without sign-in that check arrives as the owner, like everything else: it is known by the name it gives itself.
      if (messages.length && extra.authInfo?.extra?.devmatePrincipal?.id === 'owner' && said !== VERIFY_CLIENT) {
        const plain = value => String(value || '').replace(/[^\x20-\x7e]/g, '').slice(0, 80), userAgent = plain(sender);
        service.lastClient = { name: plain(said) || (service.lastClient?.userAgent === userAgent ? service.lastClient.name : ''), userAgent, ...decided, tunnel, at: new Date().toISOString() };
      }
      // (client: the name it goes by, for the note of who did what. Its own text, kept short and printable as above.)
      const client = String(said || (sender ? named.get(sender) : '') || '').replace(/[^\x20-\x7e]/g, '').slice(0, 80);
      return asked.run({ listing: messages.length > 0 && messages.every(message => message.method === 'tools/list'), surface: decided.surface, client }, () => handler.fetch(request, extra));
    } });
    const serverFor = ({ authInfo }) => {
      const principal = authInfo?.extra?.devmatePrincipal;
      if (!principal) throw new DomainError('unauthorized', 'A verified MCP identity is required.');
      const client = asked.getStore()?.client;
      return createMcpServer(service, { ...principal, ...(authInfo.extra.via ? { via: authInfo.extra.via } : {}), ...(client ? { client } : {}) }, asked.getStore());
    };
    // The SDK default also serves MCP clients that still speak a 2025 protocol
    // revision, statelessly. Which clients may connect is not DevMate's own history.
    // The largest text the file tools accept must fit in one request; the SDK's own bound is 4 MiB.
    mcpHandler = createMcpHandler(serverFor, { maxRequestBodySize: BODY_LIMIT });
    // The Node adapter reads the body first and has a bound of its own.
    mcp = toNodeHandler(noting(mcpHandler), { maxRequestBodySize: BODY_LIMIT });
    if (quickTunnel) {
      plainHandler = plainJsonHandler(serverFor, { maxRequestBodySize: BODY_LIMIT });
      plainMcp = toNodeHandler(noting(plainHandler), { maxRequestBodySize: BODY_LIMIT });
    }
    // A connector that cannot start does not take local work down with it, but it is never silent:
    // health says so, and connection.status and the doctor carry the reason.
    // A quick tunnel an earlier runtime left running belongs to a connection that is not this one any more.
    try { if (!quickTunnel) await endQuickTunnel(instanceRoot); }
    catch (error) { process.stderr.write(new Date().toISOString() + ' connection: ' + error.message + '\n'); }
    try { await connection.start(); }
    catch (error) {
      service.connectionFault = { code: error.code || 'connection_error', message: error.message, at: new Date().toISOString() };
      health.connection = 'failed';
      process.stderr.write(new Date().toISOString() + ' connection: ' + error.message + '\n');
    }
    try { await tunnelBeside?.start(); }
    catch (error) {
      service.tunnelFault = { code: error.code || 'connection_error', message: error.message, at: new Date().toISOString() };
      process.stderr.write(new Date().toISOString() + ' OpenAI tunnel: ' + error.message + '\n');
    }
    // A browser the owner registered starts and loads this copy of DevMate from now on (nothing where none is registered).
    try { createChromeRegistration({ instanceRoot, cli: fileURLToPath(new URL('./cli.mjs', import.meta.url)) }).refresh(); }
    catch (error) { process.stderr.write(new Date().toISOString() + ' browser registration: ' + error.message + '\n'); }
    // So does the stdio bridge of the clients the owner added DevMate to (devmate client add).
    try { createClientRegistration({ instanceRoot, cli: fileURLToPath(new URL('./cli.mjs', import.meta.url)) }).refresh(); }
    catch (error) { process.stderr.write(new Date().toISOString() + ' client registration: ' + error.message + '\n'); }
    health.status = 'ready';
    if (ingressPort) health.ingressPort = ingressPort;
    publish(recordFile, JSON.stringify({ pid: process.pid, port, ...(ingressPort ? { ingressPort } : {}), instanceId, generation,
      buildId: BUILD_ID, version: VERSION, startedAt: new Date().toISOString() }, null, 2) + '\n', generation);
    // A public route counts as working only after a real MCP round trip through it.
    // A tunnel needs a moment to register, so look often at first, then keep watching:
    // a route that breaks later must not keep its earlier "verified".
    if ((publicUrl || quickTunnel) && connectionFactory === createConnection) {
      let attempts = 0;
      const again = delay => { if (!stopping) { verifyTimer = setTimeout(check, delay); verifyTimer.unref(); } };
      const check = () => {
        if (stopping) return;
        service.verifyConnection().then(result => {
          if (result.verified) attempts = 0;
          again(result.verified || ++attempts >= 6 ? REVERIFY_MS : 5000);
        }, () => again(REVERIFY_MS));
      };
      // A quick tunnel's name is new to the world: asked about too early, resolvers remember that it does not exist.
      again(quickTunnel ? 8000 : 2000);
    }
    // Housekeeping of a process that runs for weeks. Its log is cut while it runs (the previous part is kept once); and
    // a runtime whose instance directory was deleted under it has nothing left to serve and nobody who could stop it.
    const logFile = path.join(instanceRoot, 'runtime.log');
    upkeepTimer = setInterval(() => {
      try {
        if (!fs.existsSync(instanceRoot)) { process.stderr.write('DevMate: the instance directory is gone; stopping.\n'); void stop(); return; }
        if ((fs.statSync(logFile, { throwIfNoEntry: false })?.size || 0) > LOG_LIMIT_BYTES) { fs.copyFileSync(logFile, logFile + '.1'); fs.truncateSync(logFile, 0); }
        // The system proxy is switched on and off while the runtime runs; the route is checked again when it was.
        void proxy?.refresh().then(changed => {
          if (!changed || stopping) return;
          process.stderr.write(new Date().toISOString() + ' requests to the outside now go ' + (proxy.current()?.proxy ? 'through ' + proxy.current().proxy : 'directly') + '\n');
          if (publicUrl || quickTunnel) void service.verifyConnection().catch(() => {});
        }, () => {});
      } catch {}
    }, UPKEEP_MS);
    upkeepTimer.unref();
    onReady?.({ ...health, port });
    return { server, ingress, service, connection, instanceRoot, port, ingressPort, health, stop };
  } catch (error) {
    try { await stop(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Runtime startup failed and owned resources require shutdown review.'); }
    throw error;
  }
}

/**
 * Run one runtime in this process until it is stopped. This is what the
 * background launcher starts and what `devmate serve` runs in the foreground.
 */
export async function serve(options = {}) {
  hardenExecutableSearch();
  // For the whole process, and before the first request to the outside.
  const proxy = createOutboundProxy();
  await proxy.refresh();
  const stamp = () => new Date().toISOString();
  let runtime;
  process.on('uncaughtException', error => {
    process.stderr.write(stamp() + ' uncaught exception: ' + (error?.stack || error) + '\n');
    // State may be inconsistent now. Release what this runtime owns and exit, as one that ended unexpectedly: its
    // record stays, which is what an editor host reads before it starts another. (Stopped the usual way the record
    // went with it, the status was a plain "stopped", and nothing started it again.)
    const exit = () => process.exit(1);
    setTimeout(exit, 10000).unref();
    Promise.resolve().then(() => runtime?.stop({}, { crashed: true })).then(exit, exit);
  });
  // A stray rejected promise is reported, not fatal: the request behind it has already failed on its own.
  process.on('unhandledRejection', error => { process.stderr.write(stamp() + ' unhandled rejection: ' + (error?.stack || error) + '\n'); });
  runtime = await startRuntime({ ...options, proxy, onReady: info => process.stdout.write(JSON.stringify({ event: 'ready', ...info }) + '\n') });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { void runtime.stop().catch(() => {}); });
  return runtime;
}

if (isProgram(import.meta.url, 'main.mjs')) {
  const args = process.argv.slice(2), options = {};
  try {
    for (let index = 0; index < args.length; index += 2) {
      if (args[index] === '--instance') options.instanceRoot = args[index + 1];
      else if (args[index] === '--port') options.port = Number(args[index + 1]);
      else throw new Error('Unknown runtime option: ' + args[index]);
    }
    await serve(options);
  } catch (error) {
    process.stderr.write(JSON.stringify({ event: 'failed', at: new Date().toISOString(), code: error.code || 'startup_failed', message: error.message }) + '\n');
    process.exitCode = 1;
  }
}
