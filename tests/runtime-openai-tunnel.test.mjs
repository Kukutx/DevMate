import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpenAiTunnel, responseTimeoutMs, WIRE_PROTOCOL_VERSION } from '../runtime/openai-tunnel.mjs';
import { createConnection, normalizeConnectionConfig } from '../runtime/connection.mjs';
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

  // A call with a plain answer.
  plane.queue.push(command(1, { jsonrpc: '2.0', id: 'rpc_1', method: 'tools/list', params: {} },
    { headers: { Authorization: ['Bearer from-the-connector'], 'Mcp-Protocol-Version': ['2025-06-18'], 'X-Forwarded-For': ['203.0.113.9'], Host: ['evil.example'] } }));
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
  plane.queue.push(command(2, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'shell_run' } }));
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
  assert.ok(state.served >= 7 && state.polls > 3 && state.lastCallAt && !JSON.stringify(state).includes('the-runtime-key'));

  // A key OpenAI refuses needs the owner: it is said plainly, and asked again only after a long wait.
  plane.pollStatus.push(401);
  await until(() => tunnel.status().phase === 'failed', 'the refusal');
  assert.match(tunnel.status().error.message, /OpenAI refused the runtime key for tunnel_abc123 \(HTTP 401: said by the control plane\)\. Store the key of this tunnel again: devmate secret set CONTROL_PLANE_API_KEY/);
  assert.ok(waits.includes(60000));
  await until(() => tunnel.status().phase === 'connected', 'polling to resume');
  assert.equal((await tunnel.stop()).phase, 'stopped');
  const polled = plane.polls.length; await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(plane.polls.length, polled, 'a stopped tunnel asks for nothing');
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
  plane.queue.push(command(1, { jsonrpc: '2.0', id: 'rpc_1', method: 'tools/list', params: {} }, { headers: { 'Mcp-Protocol-Version': ['2025-06-18'] } }));
  await until(() => plane.posts.some(post => post.body.request_id === 'req_1' && post.body.resp_type === 'jsonrpc_response'), 'the tool list');
  const listed = plane.posts.find(post => post.body.request_id === 'req_1' && post.body.resp_type === 'jsonrpc_response').body;
  assert.equal(listed.resp_code, 200); const shown = listed.resp_json.result.tools.map(tool => tool.name);
  assert.ok(shown.includes('exec_command') && !shown.includes('shell_run') && shown.length >= 15, 'what comes through OpenAI\'s tunnel is shown the tools a GPT model knows: ' + shown.join());
  plane.queue.push(command(2, { jsonrpc: '2.0', id: 'rpc_2', method: 'tools/call', params: { name: 'project_list', arguments: {} } }, { headers: { 'Mcp-Protocol-Version': ['2025-06-18'] } }));
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
