import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_RUNTIME_PORT = 8788;
// Set in the environment of every command and agent the runtime starts for a caller. The devmate command line
// that finds it says so with each request (viaClient), and the runtime then treats it as a connected client:
// a model that runs "devmate project add" through its shell tool gets what it would get through MCP, not the
// authority of the owner at the keyboard. A caller that removes the variable is no longer well-behaved; what
// stands against that is read-only sharing, as SECURITY.md says.
export const CLIENT_COMMAND_ENV = 'DEVMATE_CLIENT_COMMAND';
// The longest an operation waits on the server is 110 seconds (shell.run, agents.delegate).
const CALL_TIMEOUT_MS = 130000;
const EVENT_BYTES = 4 * 1024 * 1024;

export function instanceDirectory(value) {
  return path.resolve(value || path.join(os.homedir(), '.devmate', 'runtime'));
}

export function instanceFiles(value) {
  const directory = instanceDirectory(value);
  return {
    directory,
    record: path.join(directory, 'runtime.json'),
    token: path.join(directory, 'owner-token'),
    log: path.join(directory, 'runtime.log')
  };
}

export function readRuntimeRecord(value) {
  const file = instanceFiles(value).record;
  let content;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 16384) throw new Error('Invalid runtime record');
    content = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  // A record cut short by a crash is no record: whether a runtime lives is decided by the instance lock, not by this file.
  let record;
  try { record = JSON.parse(content); } catch { return null; }
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0 ||
      !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 ||
      typeof record.instanceId !== 'string' || !record.instanceId ||
      typeof record.generation !== 'string' || !record.generation) {
    throw new Error('Invalid runtime record');
  }
  return record;
}

export function localControlUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Runtime control requires a loopback HTTP origin');
  }
  return url.origin;
}

function readOwnerToken(value) {
  const files = instanceFiles(value);
  const size = fs.statSync(files.token).size;
  if (size < 1 || size > 4096) throw new Error('Invalid runtime owner token file');
  const token = fs.readFileSync(files.token, 'utf8').trim();
  if (!token || /\s/.test(token)) throw new Error('Invalid runtime owner token');
  return token;
}

export function matchesRuntime(health, record) {
  return !!record && health?.status === 'ready' && health?.name === 'DevMate' &&
    health.instanceId === record.instanceId && health.generation === record.generation &&
    health.pid === record.pid && health.buildId === record.buildId;
}

function stopped(detail) {
  const error = new Error('DevMate runtime is not running' + (detail ? ' (' + detail + ')' : '') + '. Start it with: devmate start');
  error.code = 'RUNTIME_STOPPED';
  return error;
}

export function createRuntimeClient({
  instanceRoot, baseUrl, ownerToken, windowId, viaClient = false, fetchImpl = globalThis.fetch, timeoutMs = CALL_TIMEOUT_MS
} = {}) {
  const directory = instanceDirectory(instanceRoot);
  const explicitUrl = baseUrl ? localControlUrl(baseUrl) : null;

  function target(authenticated = true) {
    const record = explicitUrl ? null : readRuntimeRecord(directory);
    if (!explicitUrl && !record) throw stopped();
    const origin = explicitUrl || `http://127.0.0.1:${record.port}`;
    let token = null;
    if (authenticated) {
      try { token = ownerToken || readOwnerToken(directory); }
      catch (error) { if (error.code === 'ENOENT') throw stopped('its owner token is gone'); throw error; }
    }
    return { origin, token, record };
  }
  async function reach(url, options) {
    try { return await fetchImpl(url, options); }
    catch (error) {
      // A record left behind by a runtime that crashed points at a port nobody listens on.
      if (['ECONNREFUSED', 'ECONNRESET'].includes(error?.cause?.code)) throw stopped('nothing answers on its recorded port');
      if (error?.name === 'TimeoutError') throw Object.assign(new Error('DevMate runtime did not answer in time.'), { code: 'RUNTIME_TIMEOUT' });
      throw error;
    }
  }

  async function request(route, { method = 'GET', body, signal, authenticated = true, scoped = true, timeoutMs: requestTimeoutMs = timeoutMs } = {}) {
    const { origin, token } = target(authenticated);
    const deadline = AbortSignal.timeout(requestTimeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const response = await reach(new URL(route, origin), {
      method,
      headers: {
        Accept: 'application/json',
        // An editor window normally acts within its own project. scoped:false is its owner deciding something about a folder.
        ...(windowId && authenticated && scoped ? { 'X-DevMate-Window-ID': windowId } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(viaClient ? { 'X-DevMate-Via': 'client' } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: origin } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: combinedSignal
    });
    const maxBytes=body?.operation==='host.record.get'?16*1024*1024:8*1024*1024;
    const chunks=[];let bytes=0;
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>maxBytes)throw new Error('Runtime response is too large');chunks.push(Buffer.from(chunk));}
    const text=Buffer.concat(chunks).toString('utf8');
    let result;
    try { result = text ? JSON.parse(text) : null; }
    catch { throw new Error(`Runtime returned invalid JSON (HTTP ${response.status})`); }
    if (!response.ok) {
      const error = new Error(result?.error?.message || result?.message || `Runtime request failed (HTTP ${response.status})`);
      error.code = result?.error?.code || 'RUNTIME_REQUEST_FAILED';
      error.status = response.status;
      if (result?.error?.details) error.details = result.error.details;
      throw error;
    }
    return result?.ok === true && Object.hasOwn(result, 'result') ? result.result : result;
  }

  async function* events({ signal, after, onConnect, scoped = true } = {}) {
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new Error('Invalid event resume cursor');
    const { origin, token } = target();
    const response = await reach(new URL('/events', origin), {
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}`,
        ...(windowId && scoped ? { 'X-DevMate-Window-ID': windowId } : {}),
        ...(after !== undefined ? { 'Last-Event-ID': String(after) } : {}) },
      redirect: 'error',
      signal
    });
    if (!response.ok || !response.body) {
      let detail = null;
      try { detail = (await response.json()).error; } catch {}
      const error = new Error(detail?.message || `Runtime events unavailable (HTTP ${response.status})`);
      error.code = detail?.code || 'RUNTIME_REQUEST_FAILED';
      throw error;
    }
    const connectionCursor = response.headers?.get('x-devmate-event-cursor');
    const generation = response.headers?.get('x-devmate-generation') || null;
    const headValue = response.headers?.get('x-devmate-event-head');
    const head = headValue !== null && headValue !== undefined ? Number(headValue) : undefined;
    if (after !== undefined && Number.isSafeInteger(head) && after > head) {
      await response.body.cancel();
      const error = new Error('Event history cursor is ahead of the runtime state.');
      error.code = 'EVENT_CURSOR_AHEAD';
      throw error;
    }
    if (typeof onConnect === 'function') onConnect({
      generation, cursor: connectionCursor !== null && connectionCursor !== undefined ? Number(connectionCursor) : after,
      head
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let type = 'message';
          let id;
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('id:')) id = line.slice(3).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (data.length) yield { type, ...(id ? { id } : {}), data: JSON.parse(data.join('\n')) };
        }
        // Only what is left is one unfinished event; a chunk may carry many complete ones.
        if (buffer.length > EVENT_BYTES) throw new Error('Runtime event is too large');
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  return {
    instanceRoot: directory,
    origin: () => target(false).origin,
    health: options => request('/health', { timeoutMs: 2000, ...options, authenticated: false }),
    snapshot: options => request('/api/snapshot', { timeoutMs: 30000, ...options }),
    call(operation, input = {}, options = {}) {
      if (typeof operation !== 'string' || !operation.trim()) throw new Error('An operation is required');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Operation input must be a JSON object');
      return request('/api/call', { ...options, method: 'POST', body: { operation, input } });
    },
    operations: options => request('/api/call', { timeoutMs: 30000, ...options, method: 'POST', body: { operation: 'operations.list', input: {} } }),
    // A link that signs one browser in to the workbench. It works once and expires within a minute.
    signInUrl: async options => (await request('/api/session', { timeoutMs: 10000, ...options, method: 'POST', body: {} })).url,
    events
  };
}
