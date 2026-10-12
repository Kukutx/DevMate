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
// Where the owner looks things up: the settings a tunnel is created in, and OpenAI's guide, whose "Troubleshooting"
// says why a tunnel is not offered in ChatGPT.
export const TUNNEL_HELP = Object.freeze({ settings: 'https://platform.openai.com/settings/organization/tunnels', guide: 'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels' });
const CONTROL_PLANE = 'https://api.openai.com';
// The wait asked for in a poll before any has come back (see loop()). The service bounds it from below: measured
// against the real one on 2026-10-12, a poll asked to wait 1000 or 5000 ms came back after about 5.5 seconds, one
// asked to wait 30000 ms after 30.4.
const FIRST_POLL_MS = 1000;
// How much longer than the wait it asked for a poll is given before it is given up. The service's own shortest wait
// and the time it takes to connect have to fit into it with room to spare: six seconds in all cut off polls that
// were about to be answered.
const POLL_GRACE_MS = 15000;
// OpenAI's interface has no code for a protocol version it has stopped taking, so that is told by what the answer says
// about the version or about the client, and by nothing vaguer: "upgrade your plan" is not it.
const OUTDATED = /(wire|protocol|client)[ _-]*version|(upgrade|update)[^.]{0,30}client|client[^.]{0,30}(too old|outdated|deprecated)/i;
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

export function createOpenAiTunnel({ tunnelId, runtimeKeyEnv = 'CONTROL_PLANE_API_KEY', organizationId = '', localMcpUrl, instanceId = '', env = process.env, maxConcurrentRequests = 32,
  fetchImpl = globalThis.fetch, pollTimeoutMs = 30000, pause = (ms, signal) => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); }),
  now = () => performance.now(), random = Math.random, limit = ms => AbortSignal.timeout(ms) } = {}) {
  if (!/^tunnel_[A-Za-z0-9_]+$/.test(tunnelId || '')) throw fault('invalid_connection', 'A valid OpenAI tunnel id is required.');
  const base = CONTROL_PLANE + '/v1/tunnels/' + encodeURIComponent(tunnelId);
  let stopper = null, running = null, phase = 'stopped', problem = null, polls = 0, served = 0, lastPollAt = null, lastCallAt = null, startedAt = null;
  // waiting: commands that arrived while every place was taken. The number asked for in a poll is only a hint to the
  // service; what it sends beyond that is served too, in turn, and never more at once than allowed.
  const active = new Set(), waiting = [];
  const key = () => String(env[runtimeKeyEnv] || '').trim();
  const common = () => ({ Authorization: 'Bearer ' + key(), 'X-Tunnel-Client-Name': 'devmate', 'X-Tunnel-Client-Version': VERSION,
    'X-Tunnel-Client-Wire-Protocol-Version': WIRE_PROTOCOL_VERSION, 'X-Tunnel-MCP-Server-Info': SERVER_INFO, ...(instanceId ? { 'X-Tunnel-Client-Instance-Id': instanceId } : {}),
    // The organization a tunnel belongs to, where OpenAI asks for it: the header its own client sends.
    ...(organizationId ? { 'OpenAI-Organization': organizationId } : {}) });
  const jitter = ms => ms / 2 + random() * ms / 2;
  // A request that ends after so many milliseconds. What is left until a deadline is a fraction (the clock counts in
  // fractions, and so may the time a call has), and AbortSignal.timeout takes whole milliseconds only: it throws for
  // anything else, which once left every call that had a deadline unserved and unanswered.
  const within = ms => limit(Math.max(1, Math.ceil(ms)));
  const stamp = () => new Date().toISOString();
  // The error of an answer, as OpenAI's API words it: a stable code where there is one, and a sentence.
  const said = async response => {
    try {
      const body = await response.json(), error = body?.error && typeof body.error === 'object' ? body.error : body;
      return { code: String(error?.code || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80), message: String(error?.message || (typeof body?.error === 'string' ? body.error : '')).slice(0, 300) };
    } catch { return { code: '', message: '' }; }
  };
  // What a refusal means for the owner, as a code and a sentence. The codes are the stable ones OpenAI publishes for its
  // tunnel service (x-tunnel-error-codes in docs/openapi.json of github.com/openai/tunnel-client). The tunnel id is
  // named as the cause only where OpenAI names it, and an answer that interface does not know is passed on as it is.
  function refusal(status, { code, message }) {
    const answer = 'HTTP ' + status + (code ? ' ' + code : '') + (message ? ': ' + message : ''), again = 'devmate connect openai-tunnel --tunnel-id ' + tunnelId;
    const official = 'OpenAI\'s own tunnel-client can carry the tunnel (' + again + ' --executable <path of tunnel-client>)';
    if (code === 'invalid_tunnel_id_format') return ['tunnel_id', 'OpenAI does not take ' + tunnelId + ' for a tunnel id (' + answer + '). Copy the id from ' + TUNNEL_HELP.settings + ' and set it: devmate connect openai-tunnel --tunnel-id <id>'];
    if (code === 'tunnel_active_organization_required') return ['organization_required', 'OpenAI has to be told which organization ' + tunnelId + ' belongs to (' + answer + '). ' +
      (organizationId ? 'It was told ' + organizationId + ' and does not take that. ' : '') + 'Name the organization of the tunnel: ' + again + ' --organization <organization id>'];
    if (code === 'tunnel_use_forbidden' || code === 'tunnel_missing_principals') return ['not_permitted', 'This runtime key may not use ' + tunnelId + ' (' + answer + '). The key has to come from the organization or workspace the tunnel belongs to: create it for this tunnel at ' +
      TUNNEL_HELP.settings + ' and store it with devmate secret set ' + runtimeKeyEnv];
    if (status === 401 || status === 403) return ['not_authorized', 'OpenAI refused the runtime key for ' + tunnelId + ' (' + answer + '). Store the key of this tunnel again: devmate secret set ' + runtimeKeyEnv];
    if (status === 426 || OUTDATED.test(code + ' ' + message)) return ['protocol_outdated', 'OpenAI no longer takes version ' + WIRE_PROTOCOL_VERSION + ' of the tunnel protocol, the one this DevMate speaks (' + answer + '). Update DevMate. Until then ' + official + '.'];
    if (status === 404) return ['refused_404', 'OpenAI finds no tunnel ' + tunnelId + ' (' + answer + '). Compare the id with the one at ' + TUNNEL_HELP.settings + '.'];
    return ['refused_' + status, 'OpenAI hands out no work for ' + tunnelId + ' (' + answer + '). Its published interface names no such answer, so the cause cannot be told from here. If it stays so with the newest DevMate, ' + official + '.'];
  }

  // One answer back to the control plane. A final answer is tried again where the protocol allows it, until the
  // command's deadline; a progress message is sent once.
  async function post(command, payload, { terminal, deadline, signal }) {
    const body = JSON.stringify({ request_id: command.request_id, ...(command.channel ? { channel: command.channel } : {}), ...payload });
    for (let attempt = 0, delay = 500; ; attempt++, delay = Math.min(delay * 2, 8000)) {
      if (signal.aborted || (deadline !== null && now() >= deadline)) return false;
      let response = null;
      try {
        response = await fetchImpl(base + '/response', { method: 'POST', redirect: 'error', headers: { ...common(), 'Content-Type': 'application/json', 'X-Tunnel-Shard-Token': command.shard_token }, body,
          signal: AbortSignal.any([signal, within(deadline === null ? 30000 : Math.min(30000, deadline - now()))]) });
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
        signal: deadline === null ? signal : AbortSignal.any([signal, within(deadline - now())]) });
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
      // Whether OpenAI takes this client is known when a poll comes back, and a long poll with nothing to hand out
      // comes back late. Until one has come back the wait asked for is short, so that "connected", or the refusal,
      // is there within a second or two of a start instead of half a minute.
      const asked = phase === 'connected' ? pollTimeoutMs : Math.min(pollTimeoutMs, FIRST_POLL_MS), patience = within(asked + POLL_GRACE_MS);
      try {
        response = await fetchImpl(base + '/poll?limit=' + Math.min(25, room) + '&timeout_ms=' + asked, { headers: common(), redirect: 'error',
          signal: AbortSignal.any([signal, patience]) });
      } catch (error) {
        if (signal.aborted) break;
        // Two different things: no way to OpenAI, and a way on which the answer did not come in the time given to it.
        phase = 'connecting';
        problem = patience.aborted
          ? { code: 'no_answer', message: 'OpenAI did not answer a request for work within ' + Math.round((asked + POLL_GRACE_MS) / 1000) + ' seconds; asking again.', at: stamp() }
          : { code: 'unreachable', message: 'api.openai.com could not be reached: ' + String(error?.cause?.code || error?.name || error?.message || error).slice(0, 200), at: stamp() };
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
      const told = await said(response), wait = retryAfterMs(response);
      if (response.status === 429 || response.status >= 500) {
        const detail = [told.code, told.message].filter(Boolean).join(': ');
        phase = 'connecting'; problem = { code: 'control_plane_' + response.status, message: 'OpenAI answered HTTP ' + response.status + (detail ? ': ' + detail : '') + '; trying again.', at: stamp() };
        await pause(Math.max(wait, jitter(delay)), signal); delay = Math.min(delay * 2, 30000);
      } else {
        // The key, the tunnel or this client is refused. Asking again at once changes nothing: wait for the owner.
        const [code, message] = refusal(response.status, told);
        phase = 'failed'; problem = { code, message, at: stamp() };
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
