import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from './mcp.mjs';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { DevMateService } from './service.mjs';
import { DomainError } from './store.mjs';
import { VERSION, BUILD_ID } from './version.mjs';
import { createConnection } from './connection.mjs';
import { handleWorkbench } from './workbench.mjs';
import { publicMcpUrl, readConfig } from './config.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';
import { createEventStreams } from './event-stream.mjs';
import { writeAtomic } from './platform/atomic-write.mjs';
import { hardenExecutableSearch } from './platform/tools.mjs';
import { isProgram } from './platform/entry.mjs';

const FORWARDED_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'true-client-ip'];
const WORKBENCH_PATHS = ['/', '/workbench', '/workbench/'];
const SESSION_LIMIT = 16;
const SIGN_IN_CODE_MS = 60_000;
const BODY_LIMIT = 16 * 1024 * 1024;
const REVERIFY_MS = 10 * 60_000;
const UPKEEP_MS = 60_000;
const LOG_LIMIT_BYTES = 8 * 1024 * 1024;
const OWNER = Object.freeze({ id: 'owner', role: 'owner', projectIds: null });
const STATUS = { unauthorized: 401, forbidden: 403, scope_mismatch: 403, invalid_origin: 403, not_found: 404, unknown_operation: 404,
  conflict: 409, operation_conflict: 409, body_too_large: 413, invalid_host: 421, forwarded_request: 421,
  runtime_stopping: 503, runtime_unavailable: 503 };
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
function listen(listener, port, purpose) {
  return new Promise((resolve, reject) => {
    const failed = error => reject(error.code === 'EADDRINUSE'
      ? new DomainError('port_in_use', 'Port ' + port + ' on 127.0.0.1 is already used by another program. Choose another ' + purpose + ' port.') : error);
    listener.once('error', failed);
    listener.listen({ host: '127.0.0.1', port }, () => { listener.off('error', failed); resolve(); });
  });
}

export async function startRuntime({ instanceRoot = path.join(os.homedir(), '.devmate', 'runtime'), port = 8788, ingressPort,
  adapterFactory, connectionFactory = createConnection, capabilitiesFactory, authOptions, onReady } = {}) {
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
  const token = randomBytes(32).toString('hex');
  let config;
  try {
    config = readConfig(instanceRoot);
    publish(tokenFile, token);
  } catch (error) { await lock.close(); throw error; }
  let stopping = false, stopPromise, connection, service, mcp, mcpHandler, streams, verifyTimer, upkeepTimer;
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
  const publicOrigin = config.auth.mode === 'oauth' ? config.auth.issuer : publicUrl ? new URL(publicUrl).origin : null;
  const hasIngress = publicOrigin !== null || config.connection.kind === 'openai-tunnel';
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
      if (status === 500) process.stderr.write(new Date().toISOString() + ' ' + req.method + ' ' + req.url.split('?')[0] + ': ' + (error.stack || error) + '\n');
      if (res.headersSent) { res.end(); return; }
      send(res, status, content);
    }
  };
  async function serveMcp(req, res, local) {
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
    // does present a token is exactly who that token says, or nobody.
    const { principal, reason } = local && !req.headers.authorization ? { principal: { ...OWNER }, reason: null } : service.auth.check(req);
    for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);
    if (!principal) {
      // The challenge tells a client where to sign in, and whether the token it sent was the problem.
      const challenge = service.auth.challenge(reason);
      if (challenge) res.setHeader('WWW-Authenticate', challenge);
      return refuse(res, 'unauthorized', reason || 'MCP authorization required.');
    }
    // The official Node adapter passes this verified identity to its per-request factory.
    req.auth = { clientId: principal.id, scopes: ['devmate'], extra: { devmatePrincipal: principal } };
    return await mcp(req, res);
  }
  const ingress = http.createServer(guarded(async (req, res) => {
    // An OpenAI tunnel client forwards to this loopback port itself; every other
    // route arrives through a proxy that preserves the configured public host.
    const tunnelLocal = config.connection.kind === 'openai-tunnel' && loopbackHost(ingress, req.headers.host);
    if (!tunnelLocal && (!publicOrigin || req.headers.host !== new URL(publicOrigin).host)) return refuse(res, 'invalid_host', 'Unexpected host.');
    const requestOrigin = tunnelLocal ? 'http://' + req.headers.host : publicOrigin;
    const url = new URL(req.url, requestOrigin);
    if (service?.auth && await service.auth.handle(req, res, url)) return;
    if (req.headers.origin && !new Set([requestOrigin, ...(config.allowedOrigins || [])]).has(req.headers.origin)) return refuse(res, 'invalid_origin', 'The origin ' + req.headers.origin + ' is not allowed. A browser-based client you run yourself is allowed by adding its origin to "allowedOrigins" in the DevMate configuration; on the local port such an origin acts as the owner.');
    if (url.pathname === '/mcp') return serveMcp(req, res, false);
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
    if (url.pathname === '/health' && req.method === 'GET') return send(res, 200, health);
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
    if (url.pathname === '/api/session' && req.method === 'POST') {
      // Only the owner token mints browser sessions; a browser session cannot multiply itself.
      if (authenticated !== 'token') return refuse(res, 'forbidden', 'A workbench sign-in link is created with the owner token.');
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
      }, { id: 'owner', role: 'owner', surface: 'local', ...(scope || {}) }) });
    }
    if (url.pathname === '/api/call' && req.method === 'POST') {
      const input = await body(req);
      if (typeof input.operation !== 'string' || !input.operation) throw new DomainError('invalid_input', 'operation must name a DevMate operation.');
      if (input.input !== undefined && (!input.input || typeof input.input !== 'object' || Array.isArray(input.input))) throw new DomainError('invalid_input', 'input must be a JSON object.');
      if (stopping && !['runtime.stop', 'host.record.get', 'host.record.put', 'host.record.list'].includes(input.operation)) return refuse(res, 'runtime_stopping', 'Runtime is stopping.');
      const context = { id: 'owner', role: 'owner', surface: 'local' };
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

  const stop = (input = {}) => {
    if (input.expectedGeneration && input.expectedGeneration !== generation) throw new DomainError('generation_mismatch', 'Runtime ownership changed.');
    if (stopPromise) return stopPromise;
    stopping = true; health.status = 'stopping';
    // The short delay lets the response to a runtime.stop request leave first.
    stopPromise = new Promise(resolve => setTimeout(resolve, 20)).then(async () => {
      clearTimeout(verifyTimer); clearInterval(upkeepTimer);
      streams?.close();
      const results = await Promise.allSettled([service?.close(), connection?.stop(), mcpHandler?.close()]);
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
      try { if (JSON.parse(fs.readFileSync(recordFile, 'utf8')).generation === generation) fs.rmSync(recordFile, { force: true }); } catch {}
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
    await service.ready;
    streams = createEventStreams({ store: service.store });
    const requestedPort = port;
    await listen(server, port, 'runtime');
    port = server.address().port;
    if (hasIngress) {
      await listen(ingress, ingressPort ?? config.ingressPort ?? (requestedPort ? requestedPort + 1 : 0), 'ingress');
      ingressPort = ingress.address().port;
    } else ingressPort = null;
    service.agents.endpoint = 'http://127.0.0.1:' + port + '/api/agent';
    service.identity = { instanceId, generation };
    connection = connectionFactory({ config: config.connection || { kind: 'local' }, instanceRoot, env: service.secrets.environment(),
      localMcpUrl: 'http://127.0.0.1:' + (ingressPort ?? port) + '/mcp' });
    service.connection = connection;
    mcpHandler = createMcpHandler(({ authInfo }) => {
      const principal = authInfo?.extra?.devmatePrincipal;
      if (!principal) throw new DomainError('unauthorized', 'A verified MCP identity is required.');
      return createMcpServer(service, principal);
    // The SDK default also serves MCP clients that still speak a 2025 protocol
    // revision, statelessly. Which clients may connect is not DevMate's own history.
    // The largest text the file tools accept must fit in one request; the SDK's own bound is 4 MiB.
    }, { maxRequestBodySize: BODY_LIMIT });
    // The Node adapter reads the body first and has a bound of its own.
    mcp = toNodeHandler(mcpHandler, { maxRequestBodySize: BODY_LIMIT });
    // A connector that cannot start does not take local work down with it, but it is never silent:
    // health says so, and connection.status and the doctor carry the reason.
    try { await connection.start(); }
    catch (error) {
      service.connectionFault = { code: error.code || 'connection_error', message: error.message, at: new Date().toISOString() };
      health.connection = 'failed';
      process.stderr.write(new Date().toISOString() + ' connection: ' + error.message + '\n');
    }
    health.status = 'ready';
    if (ingressPort) health.ingressPort = ingressPort;
    publish(recordFile, JSON.stringify({ pid: process.pid, port, ...(ingressPort ? { ingressPort } : {}), instanceId, generation,
      buildId: BUILD_ID, version: VERSION, startedAt: new Date().toISOString() }, null, 2) + '\n', generation);
    // A public route counts as working only after a real MCP round trip through it.
    // A tunnel needs a moment to register, so look often at first, then keep watching:
    // a route that breaks later must not keep its earlier "verified".
    if (publicUrl && connectionFactory === createConnection) {
      let attempts = 0;
      const again = delay => { if (!stopping) { verifyTimer = setTimeout(check, delay); verifyTimer.unref(); } };
      const check = () => {
        if (stopping) return;
        service.verifyConnection().then(result => {
          if (result.verified) attempts = 0;
          again(result.verified || ++attempts >= 6 ? REVERIFY_MS : 5000);
        }, () => again(REVERIFY_MS));
      };
      again(2000);
    }
    // Housekeeping of a process that runs for weeks. Its log is cut while it runs (the previous part is kept once); and
    // a runtime whose instance directory was deleted under it has nothing left to serve and nobody who could stop it.
    const logFile = path.join(instanceRoot, 'runtime.log');
    upkeepTimer = setInterval(() => {
      try {
        if (!fs.existsSync(instanceRoot)) { process.stderr.write('DevMate: the instance directory is gone; stopping.\n'); void stop(); return; }
        if ((fs.statSync(logFile, { throwIfNoEntry: false })?.size || 0) > LOG_LIMIT_BYTES) { fs.copyFileSync(logFile, logFile + '.1'); fs.truncateSync(logFile, 0); }
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
  const stamp = () => new Date().toISOString();
  let runtime;
  process.on('uncaughtException', error => {
    process.stderr.write(stamp() + ' uncaught exception: ' + (error?.stack || error) + '\n');
    // State may be inconsistent now. Release what this runtime owns and exit; an editor host restarts it.
    const exit = () => process.exit(1);
    setTimeout(exit, 10000).unref();
    Promise.resolve().then(() => runtime?.stop()).then(exit, exit);
  });
  // A stray rejected promise is reported, not fatal: the request behind it has already failed on its own.
  process.on('unhandledRejection', error => { process.stderr.write(stamp() + ' unhandled rejection: ' + (error?.stack || error) + '\n'); });
  runtime = await startRuntime({ ...options, onReady: info => process.stdout.write(JSON.stringify({ event: 'ready', ...info }) + '\n') });
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
