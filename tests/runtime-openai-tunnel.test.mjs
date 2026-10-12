import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { getEventListeners } from 'node:events';
import { createOpenAiTunnel, responseTimeoutMs, WIRE_PROTOCOL_VERSION, __test as tunnelTest } from '../runtime/openai-tunnel.mjs';
import { DevMateService } from '../runtime/service.mjs';
import { createConnection, normalizeConnectionConfig } from '../runtime/connection.mjs';
import { normalizeConfig } from '../runtime/config.mjs';
import { createSecretStore } from '../runtime/secrets.mjs';
import { startRuntime } from '../runtime/main.mjs';
import { main as cli } from '../runtime/cli.mjs';
import { VERSION } from '../runtime/version.mjs';

const until = async (condition, what, ms = 8000) => { const end = Date.now() + ms; while (!condition()) { if (Date.now() > end) throw new Error('timed out waiting for ' + what); await new Promise(resolve => setTimeout(resolve, 10)); } };
// OpenAI's control plane as its published contract describes it: commands are handed out by the long poll, answers
// are posted back. Everything that is not api.openai.com goes to "local", the MCP endpoint behind the tunnel.
function controlPlane(local) {
  const plane = { polls: [], posts: [], queue: [], answers: [], pollStatus: [], local: [] };
  plane.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api.openai.com') { plane.local.push({ url: url.href, headers: new Headers(init.headers), body: init.body }); return local(url, init); }
    if (url.pathname.endsWith('/poll')) {
      plane.polls.push({ query: url.searchParams, headers: new Headers(init.headers), path: url.pathname });
      // A refusal is a status, or a status with the error OpenAI's interface names for it.
      const refused = plane.pollStatus.shift();
      if (refused) return new Response(JSON.stringify({ error: { message: 'said by the control plane', type: 'invalid_request_error', ...refused.error } }), { status: refused.status || refused });
      if (plane.queue.length) return Response.json({ commands: plane.queue.splice(0) });
      // Nothing to do: the long poll ends empty, or is given up when the client stops.
      await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 20); init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true }); });
      return new Response(null, { status: 204 });
    }
    plane.posts.push({ path: url.pathname, headers: new Headers(init.headers), body: JSON.parse(init.body), raw: init.body });
    const status = plane.answers.shift();
    return status ? new Response('{}', { status }) : Response.json({ status: 'ok' });
  };
  return plane;
}
const command = (id, jsonrpc, extra = {}) => ({ request_id: 'req_' + id, shard_token: 'shard-' + id, command_type: 'jsonrpc', channel: 'main', created_at: '2026-10-11T00:00:00Z', jsonrpc, ...extra });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-internal': 'not passed on' } });
const quick = async (ms, signal) => { if (!signal?.aborted) await new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))); };

test('the timeout of a command is one whole number and one unit; anything else means no deadline', () => {
  assert.deepEqual(['30s', '4500ms', '0s', '2m', '1h', '500us'].map(responseTimeoutMs), [30000, 4500, 0, 120000, 3600000, 0.5]);
  for (const invalid of ['4.5s', '-1s', '+1s', '1m30s', ' 1s', '1s ', '1e3s', '30d', 30, null, undefined, '']) assert.equal(responseTimeoutMs(invalid), null, String(invalid));
});

test('the runtime speaks OpenAI\'s tunnel itself: it asks for work, hands each call to its own endpoint and posts what comes back', async t => {
  const waits = [];
  const plane = controlPlane(async (url, init) => {
    const message = JSON.parse(init.body);
    if (message.method === 'tools/list') return json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'project_list' }] } });
    if (message.method === 'tools/call') return new Response([
      'event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p', progress: 1 } }) + '\n\n',
      'data: ' + JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'done' }] } }) + '\n\n'].join(''), { headers: { 'content-type': 'text/event-stream', 'mcp-protocol-version': '2025-06-18' } });
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (message.method === 'broken') return new Response('<html>not json</html>', { status: 500, headers: { 'content-type': 'text/html' } });
    throw new Error('unexpected ' + message.method);
  });
  const tunnel = createOpenAiTunnel({ tunnelId: 'tunnel_abc123', localMcpUrl: 'http://127.0.0.1:8789/mcp', instanceId: 'instance-1', env: { CONTROL_PLANE_API_KEY: ' the-runtime-key ' }, fetchImpl: plane.fetch,
    pause: async (ms, signal) => { waits.push(ms); await quick(ms, signal); } });
  t.after(() => tunnel.stop());
  assert.equal((await tunnel.start()).phase, 'connecting');
  await until(() => plane.polls.length > 0 && tunnel.status().phase === 'connected', 'the first poll');
  // Every request names the key, the client and the contract it speaks; nothing about the machine behind it.
  const poll = plane.polls[0];
  assert.equal(poll.path, '/v1/tunnels/tunnel_abc123/poll'); assert.equal(poll.headers.get('authorization'), 'Bearer the-runtime-key');
  assert.deepEqual([poll.headers.get('x-tunnel-client-name'), poll.headers.get('x-tunnel-client-version'), poll.headers.get('x-tunnel-client-wire-protocol-version'), poll.headers.get('x-tunnel-client-instance-id')],
    ['devmate', VERSION, WIRE_PROTOCOL_VERSION, 'instance-1']);
  assert.equal(poll.headers.get('x-tunnel-mcp-server-info'), '{"version":1,"channels":[{"name":"main"}]}'); assert.equal(poll.headers.get('openai-organization'), null);
  assert.ok(Number(poll.query.get('limit')) >= 1 && Number(poll.query.get('limit')) <= 25); assert.equal(poll.query.get('timeout_ms'), '1000');
  // The first question is a short one, so that "connected" does not wait for a long poll; the ones after it are long.
  await until(() => plane.polls.length > 1, 'the next poll'); assert.equal(plane.polls[1].query.get('timeout_ms'), '30000');

  // A call with a plain answer. It says how long OpenAI waits for it, as the calls of the real service do.
  plane.queue.push(command(1, { jsonrpc: '2.0', id: 'rpc_1', method: 'tools/list', params: {} },
    { response_timeout: '30s', headers: { Authorization: ['Bearer from-the-connector'], 'Mcp-Protocol-Version': ['2025-06-18'], 'X-Forwarded-For': ['203.0.113.9'], Host: ['evil.example'] } }));
  await until(() => plane.posts.length === 1, 'the answer to tools/list');
  const first = plane.posts[0];
  assert.equal(first.path, '/v1/tunnels/tunnel_abc123/response'); assert.equal(first.headers.get('x-tunnel-shard-token'), 'shard-1'); assert.ok(!first.raw.includes('shard-1'), 'the shard token travels in its header only');
  assert.deepEqual(first.body, { request_id: 'req_1', channel: 'main', resp_json: { jsonrpc: '2.0', id: 'rpc_1', result: { tools: [{ name: 'project_list' }] } },
    resp_headers: { 'Content-Type': ['application/json'] }, resp_code: 200, resp_type: 'jsonrpc_response' });
  // What the call carried reaches the endpoint; what claims where it came from does not.
  const forwarded = plane.local[0].headers;
  assert.deepEqual([forwarded.get('authorization'), forwarded.get('mcp-protocol-version'), forwarded.get('x-forwarded-for'), forwarded.get('host'), forwarded.get('accept')],
    ['Bearer from-the-connector', '2025-06-18', null, null, 'application/json, text/event-stream']);
  assert.equal(plane.local[0].url, 'http://127.0.0.1:8789/mcp');

  // A call that reports while it runs: the progress goes on first, the answer ends it.
  plane.queue.push(command(2, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'shell_run' } }, { response_timeout: '30s' }));
  await until(() => plane.posts.length === 3, 'progress and answer');
  assert.deepEqual(plane.posts.slice(1).map(post => [post.body.request_id, post.body.resp_type, post.body.resp_json.method || 'result', post.headers.get('x-tunnel-shard-token')]),
    [['req_2', 'jsonrpc_notify', 'notifications/progress', 'shard-2'], ['req_2', 'jsonrpc_response', 'result', 'shard-2']]);
  assert.deepEqual(plane.posts[2].body.resp_headers, { 'Content-Type': ['text/event-stream'], 'Mcp-Protocol-Version': ['2025-06-18'] });

  // A notification has no answer; a session that does not exist is closed by saying so; neither is mistaken for the other.
  plane.queue.push(command(3, { jsonrpc: '2.0', method: 'notifications/initialized' }), { request_id: 'req_4', shard_token: 'shard-4', command_type: 'session_termination', created_at: 'x', headers: { 'Mcp-Session-Id': ['s'] } });
  await until(() => plane.posts.length === 5, 'the two acknowledgements');
  const acknowledged = Object.fromEntries(plane.posts.slice(3).map(post => [post.body.request_id, post.body]));
  assert.deepEqual([acknowledged.req_3.resp_type, acknowledged.req_3.resp_code, 'resp_json' in acknowledged.req_3], ['notify_ack', 202, false]);
  assert.deepEqual(acknowledged.req_4, { request_id: 'req_4', resp_code: 204, resp_type: 'session_termination_response' });
  const calls = plane.local.length;

  // A command of a kind nobody knows, and one that was already too late when it arrived: neither is run, neither is answered.
  plane.queue.push({ request_id: 'req_5', shard_token: 'shard-5', command_type: 'something_new', created_at: 'x', jsonrpc: { jsonrpc: '2.0', id: 1, method: 'tools/list' } },
    command(6, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { response_timeout: '0s' }));
  await until(() => tunnel.status().error?.code === 'unknown_command', 'the unknown command to be noticed');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(plane.local.length, calls); assert.equal(plane.posts.length, 5);

  // An endpoint that answers something that is no MCP answer: OpenAI is told that, with where it came from and nothing of what it said.
  plane.queue.push(command(7, { jsonrpc: '2.0', id: 'rpc_7', method: 'broken' }));
  await until(() => plane.posts.length === 6, 'the failure to be reported');
  assert.deepEqual(plane.posts[5].body.resp_json, { jsonrpc: '2.0', id: 'rpc_7', error: { code: -32603, message: 'Bad Gateway', data: { tunnel_failure: { version: 1, source: 'target_http', upstream_response_received: true, upstream_status: 500 } } } });
  assert.equal(plane.posts[5].body.resp_code, 502); assert.ok(!plane.posts[5].raw.includes('not json'));

  // An answer the control plane could not take is sent again, the same; one it no longer waits for is not.
  plane.answers.push(503, 0);
  plane.queue.push(command(8, { jsonrpc: '2.0', id: 'rpc_8', method: 'tools/list' }));
  await until(() => plane.posts.length === 8, 'the repeated answer');
  assert.equal(plane.posts[6].raw, plane.posts[7].raw);
  plane.answers.push(404);
  plane.queue.push(command(9, { jsonrpc: '2.0', id: 'rpc_9', method: 'tools/list' }));
  await until(() => plane.posts.length === 9, 'the answer nobody waits for');
  await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(plane.posts.length, 9);
  const state = tunnel.status();
  assert.deepEqual([state.kind, state.phase, state.client, state.wireProtocol, state.tunnelId, state.maxConcurrentRequests], ['openai-tunnel', 'connected', 'built-in', WIRE_PROTOCOL_VERSION, 'tunnel_abc123', 32]);
  // Delivered are the five calls the endpoint took: not the session that was closed, the two commands that were never
  // run, or the call the endpoint answered with an error.
  assert.equal(state.served, 5); assert.ok(state.polls > 3 && state.lastCallAt && !JSON.stringify(state).includes('the-runtime-key'));

  // A key OpenAI refuses needs the owner: it is said plainly, and asked again only after a long wait.
  plane.pollStatus.push(401);
  await until(() => tunnel.status().phase === 'failed', 'the refusal');
  assert.match(tunnel.status().error.message, /OpenAI refused the runtime key for tunnel_abc123 \(HTTP 401: said by the control plane\)\. Store the key of this tunnel again: devmate secret set CONTROL_PLANE_API_KEY/);
  assert.ok(waits.includes(60000));
  await until(() => tunnel.status().phase === 'connected', 'polling to resume');
  assert.equal((await tunnel.stop()).phase, 'stopped');
  const polled = plane.polls.length; await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(plane.polls.length, polled, 'a stopped tunnel asks for nothing');
});

test('a call that says how long it is waited for is served: what is left of that time is never a whole number of milliseconds', async t => {
  // The clock of the runtime counts in fractions of a millisecond, and the time a call has may be one too (500us).
  // What is left until the deadline bounds every request made for the call, to the endpoint and back to OpenAI.
  const plane = controlPlane(async (url, init) => {
    const message = JSON.parse(init.body);
    assert.ok(init.signal instanceof AbortSignal, 'the request to the endpoint ends with the call\'s time');
    if (message.method === 'tools/call') return new Response([
      'data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p', progress: 1 } }) + '\n\n',
      'data: ' + JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'done' }] } }) + '\n\n'].join(''), { headers: { 'content-type': 'text/event-stream' } });
    return json({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
  });
  let clock = 1000.123;
  const tunnel = createOpenAiTunnel({ tunnelId: 'tunnel_abc123', localMcpUrl: 'http://127.0.0.1:8789/mcp', env: { CONTROL_PLANE_API_KEY: 'k' }, fetchImpl: plane.fetch, pause: quick, now: () => (clock += 0.377) });
  t.after(() => tunnel.stop());
  await tunnel.start();
  // A plain answer, an answer that comes as a stream with progress, and one OpenAI could not take the first time.
  plane.queue.push(command(1, { jsonrpc: '2.0', id: 'rpc_1', method: 'tools/list' }, { response_timeout: '30s' }));
  await until(() => plane.posts.length === 1, 'the answer within its time');
  assert.deepEqual([plane.posts[0].body.request_id, plane.posts[0].body.resp_type, plane.posts[0].body.resp_code], ['req_1', 'jsonrpc_response', 200]);
  plane.queue.push(command(2, { jsonrpc: '2.0', id: 'rpc_2', method: 'tools/call', params: { name: 'shell_run' } }, { response_timeout: '4500ms' }));
  await until(() => plane.posts.length === 3, 'progress and answer within their time');
  assert.deepEqual(plane.posts.slice(1).map(post => [post.body.request_id, post.body.resp_type]), [['req_2', 'jsonrpc_notify'], ['req_2', 'jsonrpc_response']]);
  plane.answers.push(503);
  plane.queue.push(command(3, { jsonrpc: '2.0', id: 'rpc_3', method: 'tools/list' }, { response_timeout: '2m' }));
  await until(() => plane.posts.length === 5, 'the answer sent again within its time');
  assert.equal(plane.posts[3].raw, plane.posts[4].raw);
  // Half a millisecond is over before an answer can be there: nothing is said for such a call any more, and nothing
  // breaks for the one after it.
  plane.queue.push(command(4, { jsonrpc: '2.0', id: 'rpc_4', method: 'tools/list' }, { response_timeout: '500us' }), command(5, { jsonrpc: '2.0', id: 'rpc_5', method: 'tools/list' }, { response_timeout: '30s' }));
  await until(() => plane.posts.some(post => post.body.request_id === 'req_5'), 'the call after it');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(plane.posts.filter(post => post.body.request_id === 'req_4').length, 0); assert.equal(plane.posts.length, 6);
  assert.equal(tunnel.status().error, undefined);
});

test('a request for work is given longer than the service takes to answer it, and giving one up is not called being unreachable', async t => {
  // What the real service does (measured 2026-10-12): asked to wait 1000 or 5000 ms it answers after about 5.5
  // seconds, asked to wait 30000 ms after 30.4. A request given six seconds in all was cut off just before its answer.
  const limits = [], polls = [];
  let giveUp = 0, fails = null;
  const tunnel = createOpenAiTunnel({ tunnelId: 'tunnel_abc123', localMcpUrl: 'http://127.0.0.1:8789/mcp', env: { CONTROL_PLANE_API_KEY: 'k' }, pause: quick,
    // The time a request is given: recorded, and for the one request chosen below it is over at once.
    limit: ms => { limits.push(ms); const ending = new AbortController(); if (limits.length === giveUp) ending.abort(new DOMException('The operation timed out.', 'TimeoutError')); return ending.signal; },
    fetchImpl: async (url, init) => {
      polls.push(new URL(String(url)).searchParams.get('timeout_ms'));
      if (init.signal.aborted) throw init.signal.reason;
      if (fails) throw fails;
      await new Promise(resolve => setTimeout(resolve, 5));
      return new Response(null, { status: 204 });
    } });
  t.after(() => tunnel.stop());
  giveUp = 1;
  await tunnel.start();
  // The first request is given up: OpenAI can be reached, it only did not answer in time, and that is what is said.
  await until(() => tunnel.status().error?.code === 'no_answer' || tunnel.status().phase === 'connected', 'the first request to end');
  await until(() => tunnel.status().phase === 'connected', 'the next request to be answered');
  assert.deepEqual(polls.slice(0, 3), ['1000', '1000', '30000']);
  // A short wait asked for is given ten seconds more than the service was seen to take; a long one its own time and the same room.
  assert.ok(limits[0] >= 5600 + 10000 && limits[0] <= 20000, 'the first request is given ' + limits[0] + ' ms');
  assert.equal(limits[2], 30000 + (limits[0] - 1000));
  giveUp = limits.length + 1;
  await until(() => tunnel.status().error?.code === 'no_answer', 'a later request to be given up');
  assert.equal(tunnel.status().error.message, 'OpenAI did not answer a request for work within ' + Math.round(limits[giveUp - 1] / 1000) + ' seconds; asking again.');
  assert.doesNotMatch(tunnel.status().error.message, /could not be reached/);
  await until(() => tunnel.status().phase === 'connected' && !tunnel.status().error, 'the request after it');
  // No way to OpenAI at all is the other thing, and keeps its own words.
  fails = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  await until(() => tunnel.status().error?.code === 'unreachable', 'the failure to connect');
  assert.equal(tunnel.status().error.message, 'api.openai.com could not be reached: ENOTFOUND'); assert.equal(tunnel.status().phase, 'connecting');
});

test('a tunnel is stopped at once whatever it was waiting for, a start and a stop keep their order, and no wait leaves anything behind', async t => {
  // A wait ends with its time or with the stop, is no wait when the stop came first, and leaves nothing listening.
  const ending = new AbortController();
  for (let round = 0; round < 5; round++) await tunnelTest.rest(1, ending.signal);
  assert.equal(getEventListeners(ending.signal, 'abort').length, 0, 'five waits that ran their time left no listener');
  const waiting = tunnelTest.rest(60000, ending.signal); ending.abort(); await waiting;
  let from = Date.now(); await tunnelTest.rest(60000, ending.signal);
  assert.ok(Date.now() - from < 200, 'a wait asked for after the stop took ' + (Date.now() - from) + ' ms');
  assert.equal(getEventListeners(ending.signal, 'abort').length, 0);

  // The stop arrives while OpenAI's refusal is still being read. What follows a refusal is a wait of a minute: with the
  // real wait (none is put in its place here) the stop has to be through in a moment.
  let asked = 0;
  const refusing = createOpenAiTunnel({ tunnelId: 'tunnel_abc123', localMcpUrl: 'http://127.0.0.1:8789/mcp', env: { CONTROL_PLANE_API_KEY: 'k' },
    fetchImpl: async () => { asked++; return { status: 401, ok: false, headers: new Headers(), body: null, json: () => new Promise(resolve => setTimeout(() => resolve({ error: { message: 'no' } }), 60)) }; } });
  t.after(() => refusing.stop());
  await refusing.start();
  await until(() => asked === 1, 'the request for work');
  from = Date.now();
  assert.equal((await refusing.stop()).phase, 'stopped');
  assert.ok(Date.now() - from < 2000, 'the stop took ' + (Date.now() - from) + ' ms');
  // And one that arrives in the wait itself.
  await refusing.start();
  await until(() => refusing.status().phase === 'failed', 'the refusal');
  from = Date.now(); await refusing.stop();
  assert.ok(Date.now() - from < 1000, 'the stop took ' + (Date.now() - from) + ' ms');

  // A start asked for while a stop is under way is done after it, not lost in it and not counted as stopped by it.
  const plane = controlPlane(async () => { throw new Error('no call is expected'); });
  const tunnel = createOpenAiTunnel({ tunnelId: 'tunnel_abc123', localMcpUrl: 'http://127.0.0.1:8789/mcp', env: { CONTROL_PLANE_API_KEY: 'k' }, fetchImpl: plane.fetch, pause: quick });
  t.after(() => tunnel.stop());
  await tunnel.start();
  await until(() => tunnel.status().phase === 'connected', 'the first answer');
  const stopped = tunnel.stop(), again = tunnel.start();
  assert.equal((await stopped).phase, 'stopped'); assert.equal((await again).phase, 'connecting');
  await until(() => tunnel.status().phase === 'connected', 'the tunnel to be asking again after the start that followed the stop');
  assert.equal(tunnel.status().autoReconnect, true);
  const last = await tunnel.stop();
  assert.deepEqual([last.phase, last.autoReconnect], ['stopped', false]);
  const polled = plane.polls.length; await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(plane.polls.length, polled, 'nothing asks OpenAI for work after the last stop');
});

test('a connector is not started behind a runtime that is stopping', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-connector-stop-'));
  const done = [], stopped = { kind: 'external-https', phase: 'stopped' };
  let held = false, release = null;
  const connection = { async start() { done.push('start'); return { kind: 'external-https', phase: 'configured' }; }, status: () => ({ kind: 'external-https', phase: 'configured' }),
    stop() { done.push('stop'); return held ? new Promise(resolve => { release = () => resolve(stopped); }) : Promise.resolve(stopped); } };
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '', connection });
  await service.ready;
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const owner = { id: 'owner', surface: 'local' };
  await service.call('connection.restart', {}, owner);
  assert.deepEqual(done, ['stop', 'start']);
  // The runtime begins to stop while a restart is waiting for its connector to stop. The runtime stops its connectors
  // once; a start that came after that would leave one running that nothing stops again.
  done.length = 0; held = true;
  const restarting = service.call('connection.restart', {}, owner);
  await until(() => release, 'the restart to be stopping its connector');
  service.closing = true; release();
  await assert.rejects(restarting, { code: 'runtime_stopping' });
  assert.deepEqual(done, ['stop']);
  service.closing = false; held = false;
});

test('a refusal says what OpenAI said and what to do about that, and blames the tunnel id only where OpenAI does', async t => {
  const plane = controlPlane(async () => { throw new Error('no call is expected'); }), seen = [];
  // Every refusal is followed by a wait: what the owner is told is read there, before the next poll clears it.
  const noted = tunnel => async (ms, signal) => { const error = tunnel().status().error; if (error) seen.push({ ...error, phase: tunnel().status().phase, waited: ms }); await quick(ms, signal); };
  let tunnel = createOpenAiTunnel({ tunnelId: 'tunnel_abc', localMcpUrl: 'http://127.0.0.1:8789/mcp', env: { CONTROL_PLANE_API_KEY: 'k' }, fetchImpl: plane.fetch, pause: noted(() => tunnel) });
  t.after(() => tunnel.stop());
  const refusals = [
    { status: 400, error: { code: 'invalid_tunnel_id_format', message: 'Invalid tunnel id.' } },
    { status: 401, error: { code: 'tunnel_active_organization_required', message: 'An organization is required.' } },
    { status: 401, error: { code: 'tunnel_use_forbidden', message: 'No tunnel use permission.' } },
    { status: 401, error: { code: 'tunnel_missing_principals', message: 'No principals.' } },
    { status: 426, error: { message: 'Upgrade Required' } },
    { status: 400, error: { code: 'unsupported_client', message: 'Unsupported wire protocol version 2026-08-25.' } },
    { status: 400, error: { message: 'Upgrade your plan to use tunnels.' } },
    { status: 404, error: { message: 'Not found.' } },
    { status: 503, error: { code: 'tunnel_transport_unavailable', message: 'Try again.' } }];
  plane.pollStatus.push(...refusals);
  await tunnel.start();
  await until(() => seen.length >= refusals.length && tunnel.status().phase === 'connected', 'every refusal to be met and polling to resume');
  assert.deepEqual(seen.map(item => [item.code, item.phase, item.waited === 60000]), [['tunnel_id', 'failed', true], ['organization_required', 'failed', true], ['not_permitted', 'failed', true], ['not_permitted', 'failed', true],
    ['protocol_outdated', 'failed', true], ['protocol_outdated', 'failed', true], ['refused_400', 'failed', true], ['refused_404', 'failed', true], ['control_plane_503', 'connecting', false]]);
  const [id, organization, forbidden, , upgrade, version, plan, missing, busy] = seen.map(item => item.message);
  assert.equal(id, 'OpenAI does not take tunnel_abc for a tunnel id (HTTP 400 invalid_tunnel_id_format: Invalid tunnel id.). Copy the id from https://platform.openai.com/settings/organization/tunnels and set it: devmate connect openai-tunnel --tunnel-id <id>');
  assert.match(organization, /which organization tunnel_abc belongs to \(HTTP 401 tunnel_active_organization_required: An organization is required\.\)\. Name the organization of the tunnel: devmate connect openai-tunnel --tunnel-id tunnel_abc --organization <organization id>$/);
  assert.match(forbidden, /This runtime key may not use tunnel_abc \(HTTP 401 tunnel_use_forbidden: No tunnel use permission\.\)\. The key has to come from the organization or workspace the tunnel belongs to: .* devmate secret set CONTROL_PLANE_API_KEY$/);
  for (const outdated of [upgrade, version]) assert.match(outdated, /^OpenAI no longer takes version 2026-08-25 of the tunnel protocol, the one this DevMate speaks \(HTTP 4\d\d.*\)\. Update DevMate\. Until then OpenAI's own tunnel-client can carry the tunnel \(devmate connect openai-tunnel --tunnel-id tunnel_abc --executable <path of tunnel-client>\)\.$/);
  // An answer nobody has named is passed on as it is: neither the tunnel id nor the protocol is blamed for it.
  assert.match(plan, /^OpenAI hands out no work for tunnel_abc \(HTTP 400: Upgrade your plan to use tunnels\.\)\. Its published interface names no such answer, so the cause cannot be told from here\./); assert.doesNotMatch(plan, /tunnel id|no longer takes/);
  assert.match(missing, /^OpenAI finds no tunnel tunnel_abc \(HTTP 404: Not found\.\)\. Compare the id with the one at https:\/\/platform\.openai\.com\/settings\/organization\/tunnels\.$/);
  assert.equal(busy, 'OpenAI answered HTTP 503: tunnel_transport_unavailable: Try again.; trying again.');
  for (const message of seen.slice(1).map(item => item.message)) assert.doesNotMatch(message, /Check the tunnel id/);
  await tunnel.stop();

  // An organization that was named travels in the header OpenAI's own client uses, and a refusal of it says so.
  seen.length = 0; plane.polls.length = 0;
  tunnel = createOpenAiTunnel({ tunnelId: 'tunnel_abc', organizationId: 'org-abc', localMcpUrl: 'http://127.0.0.1:8789/mcp', env: { CONTROL_PLANE_API_KEY: 'k' }, fetchImpl: plane.fetch, pause: noted(() => tunnel) });
  plane.pollStatus.push({ status: 401, error: { code: 'tunnel_active_organization_required', message: 'An organization is required.' } });
  await tunnel.start();
  await until(() => seen.length === 1, 'the refused organization');
  assert.equal(plane.polls[0].headers.get('openai-organization'), 'org-abc'); assert.match(seen[0].message, /It was told org-abc and does not take that\. Name the organization of the tunnel: /);
  await tunnel.stop();

  // Beside a connection the tunnel is named on that connection's command: the advice must not replace the connection.
  seen.length = 0;
  tunnel = createOpenAiTunnel({ tunnelId: 'tunnel_abc', beside: true, localMcpUrl: 'http://127.0.0.1:8789/mcp', env: { CONTROL_PLANE_API_KEY: 'k' }, fetchImpl: plane.fetch, pause: noted(() => tunnel) });
  plane.pollStatus.push({ status: 400, error: { code: 'invalid_tunnel_id_format', message: 'Invalid tunnel id.' } }, { status: 401, error: { code: 'tunnel_active_organization_required', message: 'An organization is required.' } }, { status: 426, error: { message: 'Upgrade Required' } });
  await tunnel.start();
  await until(() => seen.length === 3, 'the refusals of a tunnel beside a connection');
  assert.match(seen[0].message, /and set it: devmate connect … --openai-tunnel <id>$/);
  assert.match(seen[1].message, /Name the organization of the tunnel: devmate connect … --openai-tunnel tunnel_abc --organization <organization id>$/);
  assert.match(seen[2].message, /Until then OpenAI's own tunnel-client can carry the tunnel where it is the only connection \(devmate connect openai-tunnel --tunnel-id tunnel_abc --executable <path of tunnel-client>\)\.$/);
  await tunnel.stop();

  // OpenAI's API answers a wrong key by repeating a part of it. What is said goes into the status, the doctor and the
  // report: nothing that is the key, a piece of it with stars, or could be a key is kept; the tunnel id and the name
  // of an error are.
  seen.length = 0;
  const secret = 'sk-proj-Abcdefghij0123456789KLMNOPqrstuv';
  tunnel = createOpenAiTunnel({ tunnelId: 'tunnel_0123456789abcdef0123456789', localMcpUrl: 'http://127.0.0.1:8789/mcp', env: { CONTROL_PLANE_API_KEY: secret }, fetchImpl: plane.fetch, pause: noted(() => tunnel) });
  plane.pollStatus.push({ status: 401, error: { code: 'invalid_api_key', message: 'Incorrect API key provided: sk-proj-Ab**********************stuv for tunnel_0123456789abcdef0123456789. You sent ' + secret + ' and before it rk-0123456789012345678901234 (tunnel_runtime_key_rejected).' } },
    // A header is named in letters and hyphens and is no key. What kind of answer this is, is told by the sentence as
    // it came, before anything is taken out of it: this one says that the protocol version is no longer taken.
    // Letters joined by hyphens are not a header for that alone: the beginning of a key is such a run as well.
    { status: 400, error: { message: 'X-Tunnel-Client-Wire-Protocol-Version 2026-08-25 is not supported; X-Tunnel-Shard-Token was Zx9-Abcdefghij0123456789; Mcp-Protocol-Version is fine; the key began sk-proj-AbCdEfGhIjKlMnOp.' } },
    { status: 400, error: { message: 'Not accepted: wire-protocol-version-2026-08-25.' } });
  await tunnel.start();
  await until(() => seen.length === 3, 'the refused key and the refused version');
  // Also where the words that say so are in a run of characters that is taken out before it is shown.
  assert.deepEqual([seen[2].code, /\(HTTP 400: Not accepted: \[key\]\.\)/.test(seen[2].message)], ['protocol_outdated', true]);
  assert.match(seen[0].message, /\(HTTP 401 invalid_api_key: Incorrect API key provided: \[key\] for tunnel_0123456789abcdef0123456789\. You sent \[key\] and before it \[key\] \(tunnel_runtime_key_rejected\)\.\)/);
  assert.equal(seen[1].code, 'protocol_outdated');
  assert.match(seen[1].message, /\(HTTP 400: X-Tunnel-Client-Wire-Protocol-Version 2026-08-25 is not supported; X-Tunnel-Shard-Token was \[key\]; Mcp-Protocol-Version is fine; the key began \[key\]\.\)\. Update DevMate\./);
  assert.ok(!/sk-proj|stuv|Abcdefghij|rk-0123/.test(JSON.stringify(tunnel.status())), 'nothing of a key is in the status');
});

test('no more calls are in flight than allowed, a missing key is said before anything is asked, and an endpoint that is gone is reported', async t => {
  let inFlight = 0, most = 0; const release = [];
  const plane = controlPlane(async (url, init) => {
    const message = JSON.parse(init.body);
    if (message.method === 'gone') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    inFlight++; most = Math.max(most, inFlight);
    await new Promise(resolve => release.push(resolve));
    inFlight--;
    return json({ jsonrpc: '2.0', id: message.id, result: {} });
  });
  assert.throws(() => createOpenAiTunnel({ tunnelId: 'not-a-tunnel', localMcpUrl: 'http://127.0.0.1:1/mcp' }), { code: 'invalid_connection' });
  await assert.rejects(createOpenAiTunnel({ tunnelId: 'tunnel_abc', localMcpUrl: 'http://127.0.0.1:1/mcp', env: {}, fetchImpl: plane.fetch }).start(), { code: 'missing_credential', message: /CONTROL_PLANE_API_KEY/ });
  const tunnel = createOpenAiTunnel({ tunnelId: 'tunnel_abc', localMcpUrl: 'http://127.0.0.1:8789/mcp', env: { CONTROL_PLANE_API_KEY: 'k' }, fetchImpl: plane.fetch, maxConcurrentRequests: 2, pause: quick });
  t.after(() => { release.splice(0).forEach(done => done()); return tunnel.stop(); });
  await tunnel.start();
  plane.queue.push(...[1, 2].map(id => command(id, { jsonrpc: '2.0', id, method: 'tools/call' })));
  await until(() => inFlight === 2, 'two calls in flight');
  // Both places are taken: nothing more is fetched until one is free.
  const polled = plane.polls.length;
  plane.queue.push(...[3, 4, 5].map(id => command(id, { jsonrpc: '2.0', id, method: 'tools/call' })));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(plane.polls.length, polled); assert.equal(tunnel.status().inFlight, 2);
  // One place frees up, and the service hands over all three at once, more than was asked for: none is dropped, and
  // still no more than two run at a time.
  while (plane.posts.length < 5) { release.splice(0, 1).forEach(done => done()); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(most, 2); assert.ok(plane.polls.slice(polled).every(poll => Number(poll.query.get('limit')) <= 2));
  assert.deepEqual(plane.posts.map(post => post.body.request_id).sort(), ['req_1', 'req_2', 'req_3', 'req_4', 'req_5']);
  plane.queue.push(command(6, { jsonrpc: '2.0', id: 'rpc_6', method: 'gone' }));
  await until(() => plane.posts.length === 6, 'the unreachable endpoint to be reported');
  assert.deepEqual(plane.posts[5].body.resp_json.error.data.tunnel_failure, { version: 1, source: 'connect', upstream_response_received: false }); assert.equal(plane.posts[5].body.resp_code, 502);
});

test('a tunnel without a program is spoken by the runtime, end to end: a call from OpenAI gets this runtime\'s real answer, and the doctor counts it', async t => {
  const settings = normalizeConnectionConfig({ kind: 'openai-tunnel', tunnelId: 'tunnel_abc123' });
  assert.deepEqual(settings, { kind: 'openai-tunnel', tunnelId: 'tunnel_abc123', runtimeKeyEnv: 'CONTROL_PLANE_API_KEY', maxConcurrentRequests: 32 });
  // OpenAI's own program is still used where its path is given, and is told how many calls to hold.
  assert.equal(normalizeConnectionConfig({ kind: 'openai-tunnel', tunnelId: 'tunnel_abc123', executable: process.execPath, maxConcurrentRequests: 64 }).executable, process.execPath);
  for (const bad of [{ tunnelId: 'abc' }, { tunnelId: 'tunnel_abc', executable: 'tunnel-client' }, { tunnelId: 'tunnel_abc', maxConcurrentRequests: 0 }, { tunnelId: 'tunnel_abc', maxConcurrentRequests: 1000 },
    { tunnelId: 'tunnel_abc', organizationId: 'org abc\r\nX-Injected: 1' }]) {
    assert.throws(() => normalizeConnectionConfig({ kind: 'openai-tunnel', ...bad }), Error, JSON.stringify(bad));
  }
  assert.equal(normalizeConnectionConfig({ kind: 'openai-tunnel', tunnelId: 'tunnel_abc123', organizationId: ' org-abc ' }).organizationId, 'org-abc');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-openai-tunnel-')), instanceRoot = path.join(temp, 'instance'), projectRoot = path.join(temp, 'project');
  let runtime;
  t.after(async () => { await runtime?.stop(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  fs.mkdirSync(projectRoot);
  // The command line sets it up with the tunnel id alone; the key is stored the way every credential is.
  const out = { text: '', write(value) { out.text += value; } };
  assert.equal(await cli(['connect', 'openai-tunnel', '--tunnel-id', 'tunnel_abc123', '--instance', instanceRoot], { stdout: out, stderr: { write() {} }, env: {} }), 0, out.text);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(instanceRoot, 'config.json'), 'utf8')).connection, settings);
  // The organization of the tunnel is named the same way, and kept with it.
  const named = path.join(temp, 'with-organization');
  assert.equal(await cli(['connect', 'openai-tunnel', '--tunnel-id', 'tunnel_abc123', '--organization', 'org-abc', '--instance', named], { stdout: { write() {} }, stderr: { write() {} }, env: {} }), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(named, 'config.json'), 'utf8')).connection, { ...settings, organizationId: 'org-abc' });
  createSecretStore(instanceRoot).set('CONTROL_PLANE_API_KEY', 'the-runtime-key');
  const plane = controlPlane((url, init) => fetch(url, init));
  runtime = await startRuntime({ instanceRoot, port: 0, connectionFactory: options => createConnection({ ...options, fetchImpl: plane.fetch }) });
  await runtime.service.call('project.create', { root: projectRoot, name: 'Tunnelled' }, { id: 'owner', surface: 'local' });
  await until(() => plane.polls.length > 0, 'the runtime to ask OpenAI for work');
  assert.equal(plane.polls[0].headers.get('authorization'), 'Bearer the-runtime-key');
  const doctor = async () => Object.fromEntries((await runtime.service.call('runtime.doctor', {}, { id: 'owner', surface: 'local' })).checks.map(item => [item.id, item]));
  // "connected" is said once OpenAI has answered the first question, not once it was asked.
  let checks = await doctor();
  for (const end = Date.now() + 8000; !/: connected /.test(checks['connection.process'].detail) && Date.now() < end;) { await new Promise(resolve => setTimeout(resolve, 20)); checks = await doctor(); }
  assert.match(checks['connection.process'].detail, /^openai-tunnel: connected \(spoken by DevMate itself, protocol 2026-08-25, up to 32 calls at once\)$/); assert.equal(checks['connection.executable'], undefined);
  assert.equal(checks['connection.public'].status, 'info'); assert.match(checks['connection.public'].detail, /no call has come through it yet/);
  // Connected and not offered in ChatGPT is a matter of the OpenAI account: the doctor says so, and where OpenAI explains it.
  assert.match(checks['connection.public'].fix, /If ChatGPT does not offer the tunnel, the cause is in the OpenAI account and not in DevMate, which is connected: the tunnel has to include the ChatGPT workspace you use/);
  assert.match(checks['connection.public'].fix, /https:\/\/platform\.openai\.com\/settings\/organization\/tunnels; "Troubleshooting" in https:\/\/developers\.openai\.com\/api\/docs\/guides\/secure-mcp-tunnels/);
  // What ChatGPT sends: the tool list, then a tool call. The answers are this runtime's own.
  plane.queue.push(command(1, { jsonrpc: '2.0', id: 'rpc_1', method: 'tools/list', params: {} }, { response_timeout: '30s', headers: { 'Mcp-Protocol-Version': ['2025-06-18'] } }));
  await until(() => plane.posts.some(post => post.body.request_id === 'req_1' && post.body.resp_type === 'jsonrpc_response'), 'the tool list');
  const listed = plane.posts.find(post => post.body.request_id === 'req_1' && post.body.resp_type === 'jsonrpc_response').body;
  assert.equal(listed.resp_code, 200); const shown = listed.resp_json.result.tools.map(tool => tool.name);
  assert.ok(shown.includes('exec_command') && !shown.includes('shell_run') && shown.length >= 15, 'what comes through OpenAI\'s tunnel is shown the tools a GPT model knows: ' + shown.join());
  plane.queue.push(command(2, { jsonrpc: '2.0', id: 'rpc_2', method: 'tools/call', params: { name: 'project_list', arguments: {} } }, { response_timeout: '30s', headers: { 'Mcp-Protocol-Version': ['2025-06-18'] } }));
  await until(() => plane.posts.some(post => post.body.request_id === 'req_2' && post.body.resp_type === 'jsonrpc_response'), 'the tool call');
  const called = plane.posts.find(post => post.body.request_id === 'req_2' && post.body.resp_type === 'jsonrpc_response').body.resp_json;
  assert.match(JSON.stringify(called.result), /Tunnelled/);
  // A call that arrived is the proof no probe can give.
  await until(() => runtime.connection.status().served >= 2, 'the calls to be counted');
  checks = await doctor();
  assert.equal(checks['connection.public'].status, 'ok'); assert.match(checks['connection.public'].detail, /OpenAI's tunnel has delivered 2 call\(s\) to this runtime/);
  // Who that was and why it saw a GPT model's tool names; a tunnel id has no place for "?tools=", so none is advised.
  assert.match(checks.client.detail, /^The last MCP client called itself nothing \(sender line "[^"]+"\) and was shown the tool names of ChatGPT and Codex, because it came through OpenAI's tunnel, at /); assert.equal(checks.client.fix, undefined);
});

// One MCP message to the ingress port, under the Host a proxy in front of it would send, or any other.
function ask(port, host, message, { headers = {}, pathname = '/mcp' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => {
        const type = String(res.headers['content-type'] || '').split(';')[0];
        // One JSON body, or the last message of an event stream.
        const data = type === 'text/event-stream' ? text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).pop() : text;
        let json = null; try { json = JSON.parse(data); } catch { /* not an answer */ }
        resolve({ status: res.statusCode, type, challenge: res.headers['www-authenticate'], json });
      });
    });
    req.once('error', reject); req.end(JSON.stringify(message));
  });
}
const list = id => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
const call = (id, name, input = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: input } });
const names = answer => answer.result.tools.map(tool => tool.name);
const answerTo = (plane, id) => plane.posts.find(post => post.body.request_id === 'req_' + id && post.body.resp_type === 'jsonrpc_response')?.body;
const publicHost = 'devmate.example.com', publicAddress = 'https://' + publicHost + '/mcp';

test('OpenAI\'s tunnel runs beside a public address: each way in is served as itself, and the tunnel\'s way cannot be taken from outside', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-tunnel-beside-')), instanceRoot = path.join(temp, 'instance'), projectRoot = path.join(temp, 'project');
  let runtime;
  t.after(async () => { await runtime?.stop(); await runtime?.service.tunnel?.stop(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  fs.mkdirSync(projectRoot);
  const run = async (args, instance = instanceRoot, env = {}) => {
    const stdout = { text: '', write(value) { stdout.text += value; } }, stderr = { text: '', write(value) { stderr.text += value; } };
    return { code: await cli([...args, '--instance', instance], { stdout, stderr, env, remove: async () => ({ removed: true, notes: [] }) }), stdout: stdout.text, stderr: stderr.text };
  };
  const saved = (instance = instanceRoot) => JSON.parse(fs.readFileSync(path.join(instance, 'config.json'), 'utf8'));
  const tunnel = { tunnelId: 'tunnel_abc123', runtimeKeyEnv: 'CONTROL_PLANE_API_KEY', maxConcurrentRequests: 32 };
  // One command names both ways in, and says which key is still to be stored.
  const both = await run(['connect', 'https', '--url', publicAddress, '--openai-tunnel', 'tunnel_abc123', '--organization', 'org-abc']);
  assert.equal(both.code, 0, both.stderr);
  assert.deepEqual(saved().connection, { kind: 'external-https', url: publicAddress }); assert.deepEqual(saved().openaiTunnel, { ...tunnel, organizationId: 'org-abc' });
  assert.match(both.stdout, /Store the runtime key of the tunnel: devmate secret set CONTROL_PLANE_API_KEY/);
  // A second way in makes what is shared reachable by more: like every connection it is the owner's to set up, at the
  // computer. A devmate command a connected client runs is refused, and nothing is changed by it.
  const byClient = await run(['connect', 'https', '--url', publicAddress, '--openai-tunnel', 'tunnel_other999'], instanceRoot, { DEVMATE_CLIENT_COMMAND: '1' });
  assert.notEqual(byClient.code, 0); assert.match(byClient.stderr, /run by the owner in their own terminal/); assert.equal(saved().openaiTunnel.tunnelId, 'tunnel_abc123');
  // Beside nothing the tunnel is the connection itself, and is chosen as that.
  const alone = await run(['connect', 'local', '--openai-tunnel', 'tunnel_abc123'], path.join(temp, 'alone'));
  assert.notEqual(alone.code, 0); assert.match(alone.stderr, /devmate connect openai-tunnel --tunnel-id tunnel_abc123/);
  assert.equal(normalizeConfig({ openaiTunnel: { tunnelId: 'tunnel_abc123' } }).openaiTunnel, undefined);
  assert.equal(normalizeConfig({ connection: { kind: 'openai-tunnel', tunnelId: 'tunnel_abc123' }, openaiTunnel: { tunnelId: 'tunnel_def456' } }).openaiTunnel, undefined);
  // OpenAI's own program cannot be told the secret of this start, so beside an address the runtime speaks the tunnel itself.
  const address = { connection: { kind: 'external-https', url: publicAddress } };
  assert.throws(() => normalizeConfig({ ...address, openaiTunnel: { tunnelId: 'tunnel_abc123', executable: process.execPath } }), { name: 'ZodError' });
  assert.throws(() => normalizeConfig({ ...address, openaiTunnel: { tunnelId: 'not-a-tunnel' } }), /tunnel_id/);
  assert.deepEqual(normalizeConfig({ ...address, openaiTunnel: { tunnelId: 'tunnel_abc123' } }).openaiTunnel, tunnel);
  // A connection set up without naming the tunnel is set up alone. A tunnel that goes that way is said, with the way to
  // keep it: the one that ran beside the connection, and the one that was the connection until now.
  const other = path.join(temp, 'other');
  await run(['connect', 'https', '--url', publicAddress, '--openai-tunnel', 'tunnel_abc123', '--organization', 'org-abc'], other);
  const without = await run(['connect', 'https', '--url', publicAddress], other);
  assert.equal(saved(other).openaiTunnel, undefined); assert.match(without.stdout, /OpenAI's tunnel tunnel_abc123 is no longer used\. To run it beside this connection: devmate connect beside --openai-tunnel tunnel_abc123 --organization org-abc"/);
  await run(['connect', 'openai-tunnel', '--tunnel-id', 'tunnel_abc123'], other);
  assert.match((await run(['connect', 'https', '--url', publicAddress], other)).stdout, /To run it beside this connection: devmate connect beside --openai-tunnel tunnel_abc123"/);
  assert.doesNotMatch((await run(['connect', 'https', '--url', publicAddress], other)).stdout, /no longer used/, 'nothing is said where no tunnel was');
  // The command that was just named: the tunnel is put beside the connection there is, changed and taken away without
  // that connection being named again, and what is printed names its kind alone.
  const put = await run(['connect', 'beside', '--openai-tunnel', 'tunnel_abc123', '--organization', 'org-abc'], other);
  assert.equal(put.code, 0, put.stderr);
  assert.deepEqual(saved(other).connection, { kind: 'external-https', url: publicAddress }); assert.deepEqual(saved(other).openaiTunnel, { ...tunnel, organizationId: 'org-abc' });
  assert.deepEqual(JSON.parse(put.stdout).saved, { connection: { kind: 'external-https' }, auth: { mode: 'none' }, openaiTunnel: { ...tunnel, organizationId: 'org-abc' } });
  await run(['connect', 'beside', '--openai-tunnel', 'tunnel_other999'], other);
  assert.deepEqual(saved(other).openaiTunnel, { ...tunnel, tunnelId: 'tunnel_other999' }, 'another one in its place, with nothing of the one before');
  const taken = await run(['connect', 'beside', '--openai-tunnel', 'none'], other);
  assert.equal(saved(other).openaiTunnel, undefined); assert.deepEqual(saved(other).connection, { kind: 'external-https', url: publicAddress });
  assert.match(taken.stdout, /OpenAI's tunnel tunnel_other999 is no longer used\. To run it beside this connection: devmate connect beside --openai-tunnel tunnel_other999"/);
  // Where there is nothing for it to do it says why, and writes nothing: none to take away, no tunnel named, a sign-in
  // (which belongs to the address), no connection to be beside, and a tunnel that is the connection itself.
  await run(['connect', 'openai-tunnel', '--tunnel-id', 'tunnel_abc123'], path.join(temp, 'itself'));
  for (const [args, instance, says] of [
    [['--openai-tunnel', 'none'], other, /No OpenAI tunnel runs beside this connection/],
    [[], other, /connect beside needs --openai-tunnel/],
    [['--openai-tunnel', 'tunnel_abc123', '--auth', 'oauth'], other, /changes the tunnel alone/],
    [['--openai-tunnel', 'tunnel_abc123'], path.join(temp, 'nothing'), /On its own the tunnel is: devmate connect openai-tunnel --tunnel-id tunnel_abc123/],
    [['--openai-tunnel', 'tunnel_def456'], path.join(temp, 'itself'), /tunnel_abc123 is the connection itself here.*devmate connect beside --openai-tunnel tunnel_abc123/]
  ]) { const answer = await run(['connect', 'beside', ...args], instance); assert.notEqual(answer.code, 0, args.join(' ')); assert.match(answer.stderr, says); }
  assert.equal(saved(other).openaiTunnel, undefined); assert.ok(!fs.existsSync(path.join(temp, 'nothing'))); assert.equal(saved(path.join(temp, 'itself')).connection.tunnelId, 'tunnel_abc123');
  // Which tunnel a stored key was made for cannot be seen: a key that is there is named, with what to do if it is
  // another tunnel's, and one that is not there is asked for. Either sentence holds whatever was set up here before.
  const again = ['connect', 'https', '--url', publicAddress, '--openai-tunnel', 'tunnel_abc123'], storeIt = /"Store the runtime key of the tunnel: devmate secret set CONTROL_PLANE_API_KEY"/;
  const isStored = /"CONTROL_PLANE_API_KEY is stored already and will be used\. If it is the runtime key of another tunnel, store this one's: devmate secret set CONTROL_PLANE_API_KEY"/;
  assert.match((await run(again, other)).stdout, storeIt, 'not stored yet');
  createSecretStore(other).set('CONTROL_PLANE_API_KEY', 'the-runtime-key');
  for (const id of ['tunnel_abc123', 'tunnel_other999']) {
    const answer = (await run(['connect', 'https', '--url', publicAddress, '--openai-tunnel', id], other)).stdout;
    assert.match(answer, isStored, id); assert.doesNotMatch(answer, storeIt); assert.match(answer, /Apply it: devmate restart/);
  }
  assert.match((await run(['connect', 'beside', '--openai-tunnel', 'tunnel_abc123'], other)).stdout, isStored);
  // The same for the tunnel on its own.
  assert.match((await run(['connect', 'openai-tunnel', '--tunnel-id', 'tunnel_new111'], other)).stdout, /"CONTROL_PLANE_API_KEY is stored already and will be used\. If it is the credential of another tunnel, store this one's: devmate secret set CONTROL_PLANE_API_KEY"/);
  assert.match((await run(['connect', 'openai-tunnel', '--tunnel-id', 'tunnel_new111'], path.join(temp, 'fresh'))).stdout, /"Store the credential: devmate secret set CONTROL_PLANE_API_KEY"/);
  // With a sign-in at the address, it is said that the tunnel's way has none.
  const signed = (await run(['connect', 'https', '--url', publicAddress, '--auth', 'oauth', '--openai-tunnel', 'tunnel_abc123'], path.join(temp, 'signed'))).stdout;
  assert.match(signed, /"Sign-in is asked at the address only\. What comes through OpenAI's tunnel is taken as yours without it: who may use the tunnel is decided in the OpenAI account it belongs to\."/);
  assert.doesNotMatch((await run(['connect', 'https', '--url', publicAddress, '--auth', 'oauth'], path.join(temp, 'signed'))).stdout, /Sign-in is asked at the address only/);
  // The tunnel that is there, named again, keeps what was set for it: its organization, and what the settings file
  // gave it. What names a connection says nothing to this command, and is not passed over in silence.
  const kept = path.join(temp, 'kept'); fs.mkdirSync(kept);
  fs.writeFileSync(path.join(kept, 'config.json'), JSON.stringify({ connection: { kind: 'external-https', url: publicAddress }, openaiTunnel: { tunnelId: 'tunnel_abc123', organizationId: 'org-abc', runtimeKeyEnv: 'MY_TUNNEL_KEY', maxConcurrentRequests: 8 } }));
  const mine = { tunnelId: 'tunnel_abc123', organizationId: 'org-abc', runtimeKeyEnv: 'MY_TUNNEL_KEY', maxConcurrentRequests: 8 };
  assert.equal((await run(['connect', 'beside', '--openai-tunnel', 'tunnel_abc123'], kept)).code, 0); assert.deepEqual(saved(kept).openaiTunnel, mine);
  await run(['connect', 'https', '--url', publicAddress, '--openai-tunnel', 'tunnel_abc123', '--organization', 'org-other'], kept);
  assert.deepEqual(saved(kept).openaiTunnel, { ...mine, organizationId: 'org-other' }, 'the organization that is named takes the place of the one before');
  for (const [args, says] of [
    [['--openai-tunnel', 'tunnel_abc123', '--url', publicAddress, '--host', 'example.com'], /leaves the connection as it is and takes only --openai-tunnel and --organization \(given: --url, --host\)/],
    [['--openai-tunnel', 'tunnel_abc123', '--tunnel-id', 'tunnel_def456'], /\(given: --tunnel-id\)/],
    [['--openai-tunnel', 'tunnel_abc123', '--ssh-port', '2222', '--identity', 'key', '--domain', 'relay.example.com'], /\(given: --ssh-port, --identity, --domain\)/],
    [['--openai-tunnel', 'none', '--organization', 'org-abc'], /--organization says nothing of a tunnel that is no longer there/]
  ]) { const answer = await run(['connect', 'beside', ...args], kept); assert.notEqual(answer.code, 0, args.join(' ')); assert.match(answer.stderr, says); }
  assert.deepEqual(saved(kept).openaiTunnel, { ...mine, organizationId: 'org-other' }, 'a refused command wrote nothing');
  // The same where the tunnel was the connection until now and OpenAI's own program carried it: put beside an address
  // it is still that tunnel, with its organization and with the name its key is stored under.
  const carried = path.join(temp, 'carried'); fs.mkdirSync(carried);
  fs.writeFileSync(path.join(carried, 'config.json'), JSON.stringify({ connection: { kind: 'openai-tunnel', tunnelId: 'tunnel_abc123', executable: process.execPath, organizationId: 'org-abc', runtimeKeyEnv: 'MY_TUNNEL_KEY' } }));
  const moved = await run(['connect', 'https', '--url', publicAddress, '--openai-tunnel', 'tunnel_abc123'], carried);
  assert.deepEqual(saved(carried).openaiTunnel, { tunnelId: 'tunnel_abc123', organizationId: 'org-abc', runtimeKeyEnv: 'MY_TUNNEL_KEY', maxConcurrentRequests: 32 });
  assert.match(moved.stdout, /"Store the runtime key of the tunnel: devmate secret set MY_TUNNEL_KEY"/);

  // A relay is not changed by naming its address on another connection: it is replaced, which is said with what is
  // lost by it and with the command that adds a tunnel to a relay.
  const keyFile = path.join(temp, 'relay-key');
  const relayConfig = { connection: { kind: 'ssh', publicUrl: publicAddress + '/' + 'k'.repeat(32), executable: process.execPath, host: '203.0.113.7', user: 'deploy', relay: true, sshPort: 2222, identityFile: keyFile } };
  const replaced = path.join(temp, 'replaced'); fs.mkdirSync(replaced);
  fs.writeFileSync(path.join(replaced, 'config.json'), JSON.stringify(relayConfig));
  const plain = await run(['connect', 'ssh', '--url', relayConfig.connection.publicUrl, '--host', '203.0.113.7', '--user', 'deploy', '--executable', process.execPath, '--openai-tunnel', 'tunnel_abc123'], replaced);
  assert.equal(plain.code, 0, plain.stderr); assert.equal(saved(replaced).connection.relay, undefined);
  // The commands it names reach that relay: with its port, its key file and the name it answers under. Without them
  // they would log in on port 22 with no key, and set a relay up under the server's bare address.
  const how = ' --ssh-port 2222 --identity "' + keyFile + '"';
  assert.equal(JSON.parse(plain.stdout).next.find(line => line.startsWith('The relay on')), 'The relay on 203.0.113.7 was the connection until now, and this command put another in its place: a plain SSH connection, without the relay\'s own ports and key file and without telling the relay the address of this computer. ' +
    'The relay stays installed on that server. To make that server the relay again: devmate relay setup deploy@203.0.113.7 --domain ' + publicHost + how + ' (its address is then a new one, which the client has to be given: devmate mcp-url); ' +
    'to take it off the server: devmate relay remove deploy@203.0.113.7' + how + '. To put OpenAI\'s tunnel beside a relay, leave the relay as it is and run: devmate connect beside --openai-tunnel <tunnel id>');
  assert.doesNotMatch((await run(['connect', 'https', '--url', publicAddress], replaced)).stdout, /The relay on/, 'said once, where the relay was replaced');
  fs.writeFileSync(path.join(replaced, 'config.json'), JSON.stringify(relayConfig));
  const other2 = await run(['connect', 'quick', '--executable', process.execPath], replaced);
  assert.match(other2.stdout, /"The relay on 203\.0\.113\.7 was the connection until now, and this command put another in its place\. The relay stays installed/);
  fs.writeFileSync(path.join(replaced, 'config.json'), JSON.stringify(relayConfig));
  assert.doesNotMatch((await run(['connect', 'beside', '--openai-tunnel', 'tunnel_abc123'], replaced)).stdout, /The relay on/, 'the command that leaves the relay as it is');
  assert.deepEqual([saved(replaced).connection.relay, saved(replaced).connection.sshPort, saved(replaced).connection.identityFile], [true, 2222, keyFile]);

  // A relay that is taken away leaves the tunnel that ran beside it, as the connection from then on.
  const relayed = path.join(temp, 'relayed'); fs.mkdirSync(relayed);
  fs.writeFileSync(path.join(relayed, 'config.json'), JSON.stringify({ connection: { kind: 'ssh', publicUrl: publicAddress + '/' + 'k'.repeat(32), executable: process.execPath, host: '203.0.113.7', user: 'deploy', relay: true }, openaiTunnel: { tunnelId: 'tunnel_abc123' } }));
  assert.equal((await run(['relay', 'remove', 'deploy@203.0.113.7', '--executable', process.execPath], relayed)).code, 0);
  assert.deepEqual(saved(relayed).connection, { kind: 'openai-tunnel', ...tunnel }); assert.equal(saved(relayed).openaiTunnel, undefined);

  createSecretStore(instanceRoot).set('CONTROL_PLANE_API_KEY', 'the-runtime-key');
  const plane = controlPlane((url, init) => fetch(url, init));
  runtime = await startRuntime({ instanceRoot, port: 0, connectionFactory: options => createConnection({ ...options, fetchImpl: plane.fetch }) });
  const owner = { id: 'owner', surface: 'local' }, port = runtime.ingressPort, loopback = '127.0.0.1:' + port;
  await runtime.service.call('project.create', { root: projectRoot, name: 'Both ways' }, owner);
  await until(() => plane.polls.length > 0, 'the runtime to ask OpenAI for work');
  assert.equal(plane.polls[0].headers.get('openai-organization'), 'org-abc'); assert.equal(plane.polls[0].headers.get('authorization'), 'Bearer the-runtime-key');
  // Through the tunnel comes ChatGPT, and is shown what a GPT model knows. What the command says of itself in the
  // runtime's own header is not passed on.
  plane.queue.push(command(1, list('rpc_1'), { response_timeout: '30s', headers: { 'Mcp-Protocol-Version': ['2025-06-18'], 'X-DevMate-Tunnel': ['forged'] } }));
  await until(() => answerTo(plane, 1), 'the tool list through the tunnel');
  assert.equal(answerTo(plane, 1).resp_code, 200); assert.ok(names(answerTo(plane, 1).resp_json).includes('exec_command'), 'through the tunnel: the names a GPT model knows');
  const handed = plane.local.at(-1), secret = handed.headers.get('x-devmate-tunnel');
  assert.equal(new URL(handed.url).href, 'http://127.0.0.1:' + port + '/mcp'); assert.match(secret, /^[A-Za-z0-9_-]{43}$/, 'a secret of this start, and nothing a command put there');
  // Through the address comes every other client, and is shown DevMate's own names.
  const throughAddress = await ask(port, publicHost, list(2));
  assert.equal(throughAddress.status, 200); assert.ok(names(throughAddress.json).includes('shell_run') && !names(throughAddress.json).includes('exec_command'));
  // The loopback name alone opens nothing. A proxy that rewrites Host to it (nginx does unless told otherwise) would
  // otherwise make every request from outside the tunnel's.
  const byName = await ask(port, loopback, list(3));
  assert.equal(byName.status, 421); assert.equal(byName.json.error.code, 'invalid_host');
  assert.equal((await ask(port, loopback, list(4), { headers: { 'x-devmate-tunnel': 'forged' } })).status, 421);
  assert.equal((await ask(port, 'localhost:' + port, list(5), { headers: { 'x-devmate-tunnel': secret + 'x' } })).status, 421);
  assert.equal((await ask(port, loopback, list(6), { headers: { 'x-devmate-tunnel': secret } })).status, 200, 'the secret is what is checked');
  // And the secret alone opens nothing either: under the name of the address a request is one from outside, whatever
  // it says in the runtime's header, the right value included.
  const outside = await ask(port, publicHost, list(8), { headers: { 'x-devmate-tunnel': secret } });
  assert.equal(outside.status, 200); assert.ok(names(outside.json).includes('shell_run') && !names(outside.json).includes('exec_command'), 'served as the address is, not as the tunnel');
  // A client that asks how this DevMate is reached is told that there are two ways in and which one it took itself,
  // also where the owner keeps the details of the connection to this computer (the guarded profile, the default).
  plane.queue.push(command(9, call('rpc_9', 'connection_status'), { response_timeout: '30s', headers: { 'Mcp-Protocol-Version': ['2025-06-18'] } }));
  await until(() => answerTo(plane, 9), 'the answer through the tunnel');
  const generation = runtime.service.identity.generation, reached = { kind: 'external-https', phase: 'configured', instance: { generation }, remoteMcpVerified: false, openaiTunnel: { phase: 'connected' } };
  assert.deepEqual(answerTo(plane, 9).resp_json.result.structuredContent, { ...reached, via: 'openai-tunnel' });
  assert.deepEqual((await ask(port, publicHost, call(10, 'connection_status'))).json.result.structuredContent, { ...reached, via: 'address' });
  // Both ways are told apart when asked how this DevMate is reached, and by the doctor.
  await until(() => runtime.service.tunnel.status().served >= 1, 'the call to be counted');
  const status = await runtime.service.call('connection.status', {}, owner);
  assert.equal(status.kind, 'external-https'); assert.equal(status.url, publicAddress);
  assert.equal(status.openaiTunnel.tunnelId, 'tunnel_abc123'); assert.equal(status.openaiTunnel.phase, 'connected'); assert.equal(status.openaiTunnel.client, 'built-in');
  const checks = Object.fromEntries((await runtime.service.call('runtime.doctor', {}, owner)).checks.map(item => [item.id, item]));
  assert.equal(checks['tunnel.credential'].status, 'ok');
  assert.equal(checks['tunnel.process'].status, 'ok'); assert.equal(checks['tunnel.process'].detail, 'OpenAI\'s tunnel beside it: connected (spoken by DevMate itself, protocol 2026-08-25, up to 32 calls at once)');
  assert.equal(checks['tunnel.public'].status, 'ok'); assert.match(checks['tunnel.public'].detail, /OpenAI's tunnel has delivered \d+ call\(s\) to this runtime/);
  assert.match(checks['connection.process'].detail, /^external-https: configured/);
  assert.equal(checks['security.tunnel'].status, 'info'); assert.match(checks['security.tunnel'].detail, /^What comes through OpenAI's tunnel tunnel_abc123 is taken as yours without sign-in\. Who may use the tunnel is decided in the OpenAI account it belongs to, not here/);
  // Calls that came through say nothing of a tunnel that is stopped: the doctor does not call that one proven.
  await runtime.service.call('connection.stop', {}, owner);
  const idle = Object.fromEntries((await runtime.service.call('runtime.doctor', {}, owner)).checks.map(item => [item.id, item]));
  assert.equal(idle['tunnel.public'].status, 'warn'); assert.match(idle['tunnel.public'].detail, /has delivered \d+ call\(s\) to this runtime, the last one at \S+\. It is not connected now \(stopped\): nothing comes through it until it is\.$/);
  // Started again together: the key of the tunnel is stored and applied like any other.
  const polls = plane.polls.length, restarted = await runtime.service.call('connection.restart', {}, owner);
  assert.equal(restarted.kind, 'external-https'); assert.equal(restarted.openaiTunnel.tunnelId, 'tunnel_abc123');
  await until(() => plane.polls.length > polls, 'the tunnel to ask for work again');
  plane.queue.push(command(7, list('rpc_7'), { response_timeout: '30s', headers: { 'Mcp-Protocol-Version': ['2025-06-18'] } }));
  await until(() => answerTo(plane, 7), 'a call through the tunnel after the restart');
  // And stopped with the runtime: nothing goes on asking OpenAI for work.
  await runtime.stop();
  assert.equal(runtime.service.tunnel.status().phase, 'stopped');
});

test('beside an address that asks for sign-in the tunnel asks for none, and beside a quick tunnel it still carries event streams', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-tunnel-beside-auth-'));
  const runtimes = [];
  // The key of the tunnel under a name of the owner's choosing, set in the environment the runtime itself was started in.
  process.env.BESIDE_TUNNEL_KEY = 'the-runtime-key';
  t.after(async () => { delete process.env.BESIDE_TUNNEL_KEY; for (const runtime of runtimes) await runtime.stop(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const start = async (name, config, connectionFactory) => {
    const instanceRoot = path.join(temp, name); fs.mkdirSync(instanceRoot);
    fs.writeFileSync(path.join(instanceRoot, 'config.json'), JSON.stringify(config));
    createSecretStore(instanceRoot).set('CONTROL_PLANE_API_KEY', 'the-runtime-key');
    const runtime = await startRuntime({ instanceRoot, port: 0, connectionFactory }); runtimes.push(runtime);
    return runtime;
  };
  const viaTunnel = { response_timeout: '30s', headers: { 'Mcp-Protocol-Version': ['2025-06-18'] } };

  // Sign-in belongs to the address. OpenAI lets a tunnel be used by the account it belongs to, and no sign-in page can
  // be reached through one: what the runtime's own tunnel client hands over is the owner's.
  const signIn = controlPlane((url, init) => fetch(url, init));
  const guarded = await start('sign-in', { connection: { kind: 'external-https', url: publicAddress }, auth: { mode: 'oauth', issuer: 'https://' + publicHost }, openaiTunnel: { tunnelId: 'tunnel_abc123' } },
    options => createConnection({ ...options, fetchImpl: signIn.fetch }));
  const refused = await ask(guarded.ingressPort, publicHost, list(1));
  assert.equal(refused.status, 401); assert.match(refused.challenge, /resource_metadata=/);
  // Saying the runtime's header from outside changes nothing: it counts with the secret, and under the loopback name.
  assert.equal((await ask(guarded.ingressPort, publicHost, list(2), { headers: { 'x-devmate-tunnel': 'forged' } })).status, 401);
  signIn.queue.push(command(3, list('rpc_3'), viaTunnel));
  await until(() => answerTo(signIn, 3), 'the tool list through the tunnel');
  assert.equal(answerTo(signIn, 3).resp_code, 200); assert.ok(names(answerTo(signIn, 3).resp_json).includes('exec_command'));
  // Nor does the right value, said from outside: under the name of the address there is no way around the sign-in.
  const known = signIn.local.at(-1).headers.get('x-devmate-tunnel');
  assert.equal((await ask(guarded.ingressPort, publicHost, list(31), { headers: { 'x-devmate-tunnel': known } })).status, 401);
  // The doctor says the two apart: "sign-in is required" is not to be read as holding for the tunnel's way.
  const said = Object.fromEntries((await guarded.service.call('runtime.doctor', {}, { id: 'owner', surface: 'local' })).checks.map(item => [item.id, item]));
  assert.equal(said.security.detail, 'OAuth sign-in is required on the public route.');
  assert.match(said['security.tunnel'].detail, /^What comes through OpenAI's tunnel tunnel_abc123 is taken as yours without sign-in: the sign-in is asked at the address only\. Who may use the tunnel/);

  // A quick tunnel's own address answers in single JSON bodies, because Cloudflare carries no event streams through
  // it. OpenAI's tunnel does carry them, and the address ends in a key that the tunnel's way has no use for.
  const types = [], streamed = controlPlane(async (url, init) => { const response = await fetch(url, init); types.push(String(response.headers.get('content-type')).split(';')[0]); return response; });
  const host = 'beside-fixture.trycloudflare.com';
  let address = null;
  const quick = await start('quick', { connection: { kind: 'cloudflare-quick', executable: process.execPath }, openaiTunnel: { tunnelId: 'tunnel_abc123', runtimeKeyEnv: 'BESIDE_TUNNEL_KEY' } }, options => {
    if (options.config.kind === 'openai-tunnel') return createConnection({ ...options, fetchImpl: streamed.fetch });
    address = 'https://' + host + new URL(options.localMcpUrl).pathname;
    return { async start() {}, async stop() {}, publicUrl: () => address, status() { return { kind: 'cloudflare-quick', phase: 'connected', publicUrl: address, remoteMcpVerified: false }; } };
  });
  streamed.queue.push(command(4, list('rpc_4'), viaTunnel));
  await until(() => answerTo(streamed, 4), 'the tool list through the tunnel');
  assert.equal(new URL(streamed.local.at(-1).url).pathname, '/mcp'); assert.deepEqual(types, ['text/event-stream']);
  assert.ok(names(answerTo(streamed, 4).resp_json).includes('exec_command'));
  const keyed = await ask(quick.ingressPort, host, list(5), { pathname: new URL(address).pathname });
  assert.equal(keyed.status, 200); assert.equal(keyed.type, 'application/json'); assert.ok(names(keyed.json).includes('shell_run'));
  // The plain path is the tunnel's alone: from outside it is not an address, and the secret said from outside does
  // not make it one. Under the key of the address the same request is one from outside: one JSON body, DevMate's names.
  assert.equal((await ask(quick.ingressPort, host, list(6))).status, 404);
  const told = streamed.local.at(-1).headers.get('x-devmate-tunnel');
  assert.equal((await ask(quick.ingressPort, host, list(61), { headers: { 'x-devmate-tunnel': told } })).status, 404);
  const outside = await ask(quick.ingressPort, host, list(62), { pathname: new URL(address).pathname, headers: { 'x-devmate-tunnel': told } });
  assert.equal(outside.type, 'application/json'); assert.ok(names(outside.json).includes('shell_run') && !names(outside.json).includes('exec_command'));
  // A fault of the runtime itself (one is made here) is written to its log, which devmate logs prints: the path is
  // there without its key, in the request line and in what the fault says.
  const lines = [], write = process.stderr.write, handle = quick.service.auth.handle, keyed63 = new URL(address).pathname;
  process.stderr.write = chunk => { lines.push(String(chunk)); return true; };
  quick.service.auth.handle = () => { throw new Error('made to fail at ' + keyed63); };
  try { assert.equal((await ask(quick.ingressPort, host, list(63), { pathname: keyed63 })).status, 500); }
  finally { process.stderr.write = write; quick.service.auth.handle = handle; }
  assert.match(lines.join(''), / POST \/mcp\/<key>: Error: made to fail at \/mcp\/<key>\n/); assert.ok(!lines.join('').includes(keyed63.split('/').pop()), 'the key of the address is not in the log');
  // A command a client runs does not inherit the key of the tunnel, whatever the owner named it.
  assert.equal(streamed.polls[0].headers.get('authorization'), 'Bearer the-runtime-key');
  const projectRoot = path.join(temp, 'project'), owner = { id: 'owner', surface: 'local' }; fs.mkdirSync(projectRoot);
  const project = await quick.service.call('project.create', { root: projectRoot }, owner);
  const printed = await quick.service.call('shell.run', { projectId: project.id, file: process.execPath, args: ['-e', 'console.log("key:" + (process.env.BESIDE_TUNNEL_KEY || "none"))'] }, owner);
  assert.match(printed.output, /key:none/);

  // A tunnel that cannot start (its key was never stored) does not take the address down with it, and what says how
  // DevMate is reached says which of the two it is.
  const keyless = controlPlane((url, init) => fetch(url, init));
  const half = await start('keyless', { connection: { kind: 'external-https', url: publicAddress }, openaiTunnel: { tunnelId: 'tunnel_abc123', runtimeKeyEnv: 'TUNNEL_KEY_NEVER_STORED' } },
    options => createConnection({ ...options, fetchImpl: keyless.fetch }));
  assert.equal((await ask(half.ingressPort, publicHost, list(7))).status, 200); assert.equal(keyless.polls.length, 0);
  const status = await half.service.call('connection.status', {}, owner);
  assert.equal(status.phase, 'configured'); assert.equal(status.startError, undefined);
  assert.equal(status.openaiTunnel.phase, 'stopped'); assert.equal(status.openaiTunnel.startError.code, 'missing_credential');
  const checks = Object.fromEntries((await half.service.call('runtime.doctor', {}, owner)).checks.map(item => [item.id, item]));
  assert.equal(checks['connection.process'].status, 'ok');
  assert.equal(checks['tunnel.credential'].status, 'fail'); assert.equal(checks['tunnel.credential'].detail, 'TUNNEL_KEY_NEVER_STORED is missing');
  assert.equal(checks['tunnel.process'].status, 'fail'); assert.match(checks['tunnel.process'].detail, /^OpenAI's tunnel beside it: stopped .* — Missing runtime key environment variable: TUNNEL_KEY_NEVER_STORED$/);
});

test('where the tunnel is the only connection, OpenAI\'s own program is served as before and the runtime\'s own client is the owner\'s', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-tunnel-alone-'));
  const runtimes = [];
  t.after(async () => { for (const runtime of runtimes) await runtime.stop(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const start = async (name, config, connectionFactory) => {
    const instanceRoot = path.join(temp, name); fs.mkdirSync(instanceRoot);
    fs.writeFileSync(path.join(instanceRoot, 'config.json'), JSON.stringify(config));
    createSecretStore(instanceRoot).set('CONTROL_PLANE_API_KEY', 'the-runtime-key');
    const runtime = await startRuntime({ instanceRoot, port: 0, connectionFactory }); runtimes.push(runtime);
    return runtime;
  };
  // Sign-in together with a tunnel as the only connection is not something a command or a wizard sets up: it is
  // written by hand, and is what an owner has who publishes the ingress port through a proxy of their own as well.
  const signIn = { mode: 'oauth', issuer: 'https://' + publicHost };
  // OpenAI's tunnel-client program, which cannot be told the secret: whatever calls the ingress port by its loopback name.
  const program = () => ({ async start() {}, async stop() {}, status() { return { kind: 'openai-tunnel', phase: 'relay-ready', client: 'tunnel-client', remoteMcpVerified: false }; } });
  const official = { kind: 'openai-tunnel', tunnelId: 'tunnel_abc123', executable: process.execPath };
  const plain = await start('program', { connection: official }, program);
  const served = await ask(plain.ingressPort, '127.0.0.1:' + plain.ingressPort, list(1));
  assert.equal(served.status, 200); assert.ok(names(served.json).includes('exec_command'), 'taken for the tunnel by the loopback name, as before');
  // With sign-in, what the program hands over is checked like every request from outside.
  const checked = await start('program-sign-in', { connection: official, auth: signIn }, program);
  assert.equal((await ask(checked.ingressPort, '127.0.0.1:' + checked.ingressPort, list(2))).status, 401);
  // The runtime's own client says the secret: what it hands over is the owner's, also where sign-in is on. Anything
  // else that calls the port by its loopback name is checked as the program is.
  const plane = controlPlane((url, init) => fetch(url, init));
  const own = await start('own-sign-in', { connection: { kind: 'openai-tunnel', tunnelId: 'tunnel_abc123' }, auth: signIn }, options => createConnection({ ...options, fetchImpl: plane.fetch }));
  plane.queue.push(command(3, list('rpc_3'), { response_timeout: '30s', headers: { 'Mcp-Protocol-Version': ['2025-06-18'] } }));
  await until(() => answerTo(plane, 3), 'the tool list through the tunnel');
  assert.equal(answerTo(plane, 3).resp_code, 200); assert.ok(names(answerTo(plane, 3).resp_json).includes('exec_command'));
  assert.equal((await ask(own.ingressPort, '127.0.0.1:' + own.ingressPort, list(4))).status, 401);
});
