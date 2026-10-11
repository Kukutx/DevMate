import { DomainError } from './store.mjs';
import { VERSION } from './version.mjs';

// OpenAI's Secure MCP Tunnel, from the inside: this computer reaches out to api.openai.com and asks for work, and
// nothing reaches in. It needs no public address, no router setting and no server, and its address in ChatGPT (the
// tunnel id) never changes. Whoever limits it is OpenAI and nobody else.
//
// This is the client side of the wire protocol as OpenAI publishes it for authors of tunnel clients
// (docs/protocol.md and docs/openapi.json of github.com/openai/tunnel-client): long-poll for commands, hand each to
// this runtime's own MCP endpoint, post what comes back. As part of the runtime it needs no second program to be
// downloaded, started and kept current, and it serves as many calls at once as the owner allows.

export const WIRE_PROTOCOL_VERSION = '2026-08-25';
const CONTROL_PLANE = 'https://api.openai.com';
// A Streamable HTTP endpoint behind the tunnel declares itself exactly like this.
const SERVER_INFO = JSON.stringify({ version: 1, channels: [{ name: 'main' }] });
// What of the endpoint's answer the protocol carries back.
const RESPONSE_HEADERS = { 'content-type': 'Content-Type', 'mcp-session-id': 'Mcp-Session-Id', 'mcp-protocol-version': 'Mcp-Protocol-Version',
  'last-event-id': 'Last-Event-ID', 'access-control-expose-headers': 'Access-Control-Expose-Headers', 'www-authenticate': 'WWW-Authenticate' };
// What a command may not set on the request to the endpoint: hop-by-hop fields, and whatever claims where it came from.
const WITHHELD = /^(host|connection|keep-alive|proxy-.*|transfer-encoding|upgrade|te|trailer|content-length|content-type|accept|forwarded|x-forwarded-.*|x-real-ip|true-client-ip|cf-.*|x-openai-.*|openai-.*)$/i;
const RETRY_TERMINAL = new Set([408, 429, 502, 503, 504]);
const UNITS = { ns: 1e-6, us: 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000 };

const fault = (code, message) => new DomainError(code, message);
// "30s", "4500ms": one non-negative integer and one unit. Anything else means no deadline, as the protocol says.
export function responseTimeoutMs(value) {
  const match = typeof value === 'string' ? /^(\d{1,15})(ns|us|ms|s|m|h)$/.exec(value) : null;
  return match ? Number(match[1]) * UNITS[match[2]] : null;
}
// Retry-After in either of its two forms, as a number of milliseconds to wait at least.
function retryAfterMs(response, clock = Date.now) {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - clock();
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60000) : 0;
}
// Every complete event of a text/event-stream body, as its data.
async function* streamEvents(body) {
  const decoder = new TextDecoder();
  let pending = '';
  const events = function* (final) {
    for (;;) {
      const end = pending.search(/\r?\n\r?\n/);
      if (end < 0) break;
      const block = pending.slice(0, end);
      pending = pending.slice(end).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data) yield data;
    }
    if (final && pending.trim()) { const data = pending.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n'); pending = ''; if (data) yield data; }
  };
  for await (const chunk of body) { pending += decoder.decode(chunk, { stream: true }); yield* events(false); }
  pending += decoder.decode();
  yield* events(true);
}

export function createOpenAiTunnel({ tunnelId, runtimeKeyEnv = 'CONTROL_PLANE_API_KEY', localMcpUrl, instanceId = '', env = process.env, maxConcurrentRequests = 32,
  fetchImpl = globalThis.fetch, pollTimeoutMs = 30000, pause = (ms, signal) => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); }),
  now = () => performance.now(), random = Math.random } = {}) {
  if (!/^tunnel_[A-Za-z0-9_]+$/.test(tunnelId || '')) throw fault('invalid_connection', 'A valid OpenAI tunnel id is required.');
  const base = CONTROL_PLANE + '/v1/tunnels/' + encodeURIComponent(tunnelId);
  let stopper = null, running = null, phase = 'stopped', problem = null, polls = 0, served = 0, lastPollAt = null, lastCallAt = null, startedAt = null;
  // waiting: commands that arrived while every place was taken. The number asked for in a poll is only a hint to the
  // service; what it sends beyond that is served too, in turn, and never more at once than allowed.
  const active = new Set(), waiting = [];
  const key = () => String(env[runtimeKeyEnv] || '').trim();
  const common = () => ({ Authorization: 'Bearer ' + key(), 'X-Tunnel-Client-Name': 'devmate', 'X-Tunnel-Client-Version': VERSION,
    'X-Tunnel-Client-Wire-Protocol-Version': WIRE_PROTOCOL_VERSION, 'X-Tunnel-MCP-Server-Info': SERVER_INFO, ...(instanceId ? { 'X-Tunnel-Client-Instance-Id': instanceId } : {}) });
  const jitter = ms => ms / 2 + random() * ms / 2;
  const stamp = () => new Date().toISOString();
  const said = async response => { try { return String((await response.json())?.error?.message || '').slice(0, 300); } catch { return ''; } };

  // One answer back to the control plane. A final answer is tried again where the protocol allows it, until the
  // command's deadline; a progress message is sent once.
  async function post(command, payload, { terminal, deadline, signal }) {
    const body = JSON.stringify({ request_id: command.request_id, ...(command.channel ? { channel: command.channel } : {}), ...payload });
    for (let attempt = 0, delay = 500; ; attempt++, delay = Math.min(delay * 2, 8000)) {
      if (signal.aborted || (deadline !== null && now() >= deadline)) return false;
      let response = null;
      try {
        response = await fetchImpl(base + '/response', { method: 'POST', redirect: 'error', headers: { ...common(), 'Content-Type': 'application/json', 'X-Tunnel-Shard-Token': command.shard_token }, body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(deadline === null ? 30000 : Math.max(1, Math.min(30000, deadline - now())))]) });
      } catch { /* a network failure: decided below */ }
      if (response?.ok) { await response.body?.cancel(); return true; }
      const status = response?.status ?? 0, wait = response ? retryAfterMs(response) : 0;
      await response?.body?.cancel();
      // Already answered, or no longer waited for: the command is over either way and is never run again.
      if (status === 404) return true;
      const again = terminal ? (status === 0 || RETRY_TERMINAL.has(status)) && attempt < 8 : status === 429 && attempt < 2;
      if (!again) return false;
      await pause(Math.max(wait, jitter(delay)), signal);
    }
  }
  const failure = (message, source, received, upstream) => ({ resp_type: 'jsonrpc_response', resp_code: 502, resp_headers: { 'Content-Type': ['application/json'] },
    resp_json: { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: 'Bad Gateway',
      data: { tunnel_failure: { version: 1, source, upstream_response_received: received, ...(upstream ? { upstream_status: upstream } : {}) } } } } });

  async function serve(command, deadline, signal) {
    const scope = { deadline, signal }, type = command.command_type ?? (command.jsonrpc ? 'jsonrpc' : undefined);
    // This endpoint keeps no session: there is nothing to close, and that is what is acknowledged.
    if (type === 'session_termination') return post(command, { resp_code: 204, resp_type: 'session_termination_response' }, { ...scope, terminal: true });
    // A kind of command this client does not know is never mistaken for a call.
    if (type !== 'jsonrpc' || !command.jsonrpc || typeof command.jsonrpc !== 'object') { problem = { code: 'unknown_command', message: 'OpenAI sent a command of a kind this version does not know (' + String(type).slice(0, 60) + '). It was skipped.', at: stamp() }; return false; }
    const message = command.jsonrpc, asked = !Array.isArray(message) && message.id !== undefined && message.id !== null && typeof message.method === 'string';
    const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' });
    for (const [name, values] of Object.entries(command.headers || {})) {
      if (WITHHELD.test(name)) continue;
      for (const value of [].concat(values)) if (typeof value === 'string') headers.append(name, value);
    }
    let response;
    try {
      response = await fetchImpl(localMcpUrl, { method: 'POST', headers, body: JSON.stringify(message), redirect: 'error',
        signal: deadline === null ? signal : AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - now()))]) });
    } catch {
      // Past its deadline nothing is said any more; otherwise OpenAI is told that the endpoint could not be reached.
      if (signal.aborted || (deadline !== null && now() >= deadline)) return false;
      return post(command, failure(message, 'connect', false), { ...scope, terminal: true });
    }
    const kept = {};
    for (const [name, label] of Object.entries(RESPONSE_HEADERS)) { const value = response.headers.get(name); if (value) kept[label] = [value]; }
    const answered = payload => post(command, { ...payload, resp_headers: kept, resp_code: response.status }, { ...scope, terminal: true });
    try {
      if ((response.headers.get('content-type') || '').includes('text/event-stream') && response.body) {
        // What the call reports while it runs goes on as progress; the message that answers it ends the command.
        let progress = true;
        for await (const data of streamEvents(response.body)) {
          let event; try { event = JSON.parse(data); } catch { continue; }
          if (asked && event && event.id === message.id && ('result' in event || 'error' in event)) return answered({ resp_json: event, resp_type: 'jsonrpc_response' });
          if (progress) progress = await post(command, { resp_json: event, resp_headers: kept, resp_code: response.status, resp_type: 'jsonrpc_notify' }, { ...scope, terminal: false });
        }
        return asked ? post(command, failure(message, 'protocol', true), { ...scope, terminal: true }) : answered({ resp_type: 'notify_ack' });
      }
      const text = await response.text();
      // A notification has no answer; its acceptance is what is passed on.
      if (!asked && (!text.trim() || response.status === 202)) return answered({ resp_type: 'notify_ack' });
      let answer = null; try { answer = JSON.parse(text); } catch { /* not JSON: decided below */ }
      if (answer && typeof answer === 'object' && (answer.jsonrpc === '2.0' || Array.isArray(answer))) return answered({ resp_json: answer, resp_type: 'jsonrpc_response' });
      return post(command, failure(message, 'target_http', true, response.status >= 400 && response.status <= 599 ? response.status : undefined), { ...scope, terminal: true });
    } catch {
      if (signal.aborted || (deadline !== null && now() >= deadline)) return false;
      return post(command, failure(message, 'transport_closed', false), { ...scope, terminal: true });
    }
  }

  function admit(signal) {
    while (active.size < maxConcurrentRequests && waiting.length && !signal.aborted) {
      const { command, deadline } = waiting.shift();
      // Too late by now: neither run nor answered.
      if (deadline !== null && now() >= deadline) continue;
      const work = serve(command, deadline, signal).then(() => { served++; lastCallAt = stamp(); }, () => {}).finally(() => { active.delete(work); admit(signal); });
      active.add(work);
    }
  }
  async function loop(signal) {
    let delay = 1000;
    while (!signal.aborted) {
      // As many commands are fetched as there is room to serve; with none, a finished one makes room.
      const room = maxConcurrentRequests - active.size - waiting.length;
      if (room <= 0) { await Promise.race([...active, pause(1000, signal)]); continue; }
      let response;
      try {
        response = await fetchImpl(base + '/poll?limit=' + Math.min(25, room) + '&timeout_ms=' + pollTimeoutMs, { headers: common(), redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(pollTimeoutMs + 5000)]) });
      } catch (error) {
        if (signal.aborted) break;
        phase = 'connecting'; problem = { code: 'unreachable', message: 'api.openai.com could not be reached: ' + String(error?.cause?.code || error?.name || error?.message || error).slice(0, 200), at: stamp() };
        await pause(jitter(delay), signal); delay = Math.min(delay * 2, 30000);
        continue;
      }
      const received = now();
      polls++; lastPollAt = stamp();
      if (response.status === 200 || response.status === 204) {
        delay = 1000; phase = 'connected'; if (problem?.code !== 'unknown_command') problem = null;
        const commands = response.status === 200 ? (await response.json().catch(() => null))?.commands : null;
        for (const command of Array.isArray(commands) ? commands : []) {
          if (!command || typeof command.request_id !== 'string' || typeof command.shard_token !== 'string') continue;
          const timeout = responseTimeoutMs(command.response_timeout);
          waiting.push({ command, deadline: timeout === null ? null : received + timeout });
        }
        admit(signal);
        continue;
      }
      const detail = await said(response), wait = retryAfterMs(response);
      if (response.status === 401 || response.status === 403) {
        // The key is wrong or is not this tunnel's. Asking again at once changes nothing: wait for the owner.
        phase = 'failed'; problem = { code: 'not_authorized', message: 'OpenAI refused the runtime key for ' + tunnelId + ' (HTTP ' + response.status + (detail ? ': ' + detail : '') + '). Store the key of this tunnel again: devmate secret set ' + runtimeKeyEnv, at: stamp() };
        await pause(60000, signal);
      } else if (response.status === 429 || response.status >= 500) {
        phase = 'connecting'; problem = { code: 'control_plane_' + response.status, message: 'OpenAI answered HTTP ' + response.status + (detail ? ': ' + detail : '') + '; trying again.', at: stamp() };
        await pause(Math.max(wait, jitter(delay)), signal); delay = Math.min(delay * 2, 30000);
      } else {
        phase = 'failed'; problem = { code: 'refused_' + response.status, message: 'OpenAI answered HTTP ' + response.status + ' for ' + tunnelId + (detail ? ': ' + detail : '') + '. Check the tunnel id in the OpenAI Platform settings.', at: stamp() };
        await pause(60000, signal);
      }
    }
  }

  const status = () => ({ kind: 'openai-tunnel', phase, tunnelId, client: 'built-in', wireProtocol: WIRE_PROTOCOL_VERSION, maxConcurrentRequests, polls, served, inFlight: active.size, waiting: waiting.length,
    ...(startedAt ? { startedAt } : {}), ...(lastPollAt ? { lastPollAt } : {}), ...(lastCallAt ? { lastCallAt } : {}), ...(problem ? { error: problem } : {}),
    remoteMcpVerified: false, autoReconnect: running !== null, retryScheduled: false });
  async function start() {
    if (running) return status();
    if (!key()) throw fault('missing_credential', 'Missing runtime key environment variable: ' + runtimeKeyEnv);
    stopper = new AbortController(); phase = 'connecting'; problem = null; startedAt = stamp();
    const signal = stopper.signal;
    running = loop(signal).catch(error => { phase = 'failed'; problem = { code: 'client_error', message: String(error?.message || error).slice(0, 300), at: stamp() }; }).finally(() => { if (stopper?.signal === signal) running = null; });
    return status();
  }
  async function stop() {
    const loopDone = running;
    stopper?.abort();
    // Calls in flight are given up: what they started in the runtime keeps running there, as with any caller that leaves.
    waiting.length = 0;
    await Promise.allSettled([loopDone, ...active]);
    running = null; phase = 'stopped';
    return status();
  }
  return { start, stop, status, refresh(next) { env = next; } };
}
