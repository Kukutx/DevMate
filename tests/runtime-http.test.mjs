import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { startRuntime } from '../runtime/main.mjs';
import { probeInstanceLock } from '../runtime/instance-lock.mjs';

const protocol = '2026-07-28';
function localConnection() { return { async start() {}, async stop() {}, status() { return { kind: 'local', status: 'ready' }; } }; }
function raw(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.once('error', reject); req.end(body);
  });
}
async function fixture(t, extra = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-http-'));
  const instanceRoot = path.join(temp, 'instance'), projectRoot = path.join(temp, 'project');
  fs.mkdirSync(projectRoot);
  const runtime = await startRuntime({ instanceRoot, port: 0, connectionFactory: localConnection, ...extra });
  const base = 'http://127.0.0.1:' + runtime.port;
  const token = fs.readFileSync(path.join(instanceRoot, 'owner-token'), 'utf8');
  t.after(async () => { await runtime.stop(); fs.rmSync(temp, { recursive: true, force: true }); });
  const call = async (operation, input = {}, headers = {}) => {
    const response = await fetch(base + '/api/call', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...headers },
      body: JSON.stringify({ operation, input }), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  let sequence = 0;
  const rpc = async (method, params = {}, headers = {}) => {
    const response = await fetch(base + '/mcp', { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': protocol, 'mcp-method': method, ...(params.name ? { 'mcp-name': params.name } : {}), ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': protocol,
        'io.modelcontextprotocol/clientInfo': { name: 'runtime-http-fixture', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {}
      } } }) });
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body };
  };
  return { runtime, instanceRoot, projectRoot, base, token, call, rpc };
}
test('real HTTP private control requires owner auth and rejects cross-origin requests', async t => {
  const { base, token, call } = await fixture(t);
  const unauthorized = await fetch(base + '/api/snapshot'); assert.equal(unauthorized.status, 401); await unauthorized.text();
  const rejected = await call('project.list', {}, { origin: 'https://untrusted.example' });
  assert.equal(rejected.status, 403); assert.equal(rejected.body.error.code, 'invalid_origin');
  const accepted = await call('project.list', {}, { origin: base });
  assert.equal(accepted.status, 200); assert.deepEqual(accepted.body.result.items, []);
  const health = await fetch(base + '/health'); assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ready');
  assert.ok(token.length >= 32);
});
test('Host rebinding and forged agent-channel tokens are rejected', async t => {
  const { runtime, base } = await fixture(t);
  assert.equal((await raw(runtime.port, '/health', { headers: { host: 'attacker.example' } })).status, 421);
  assert.equal((await raw(runtime.port, '/health', { headers: { host: 'attacker.example:' + runtime.port } })).status, 421);
  // An editor that forwards the port from a remote machine reaches it under another local port number.
  assert.equal((await raw(runtime.port, '/health', { headers: { host: 'localhost:5123' } })).status, 200);
  const channel = await fetch(base + '/api/agent', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer forged' },
    body: JSON.stringify({ name: 'agent_peers', input: {} }) });
  assert.equal(channel.status, 401); assert.equal((await channel.json()).error.code, 'unauthorized');
});
test('the workbench is entered through a single-use link; the session stays in its tab and the owner token is never handed to a browser', async t => {
  const { runtime, token } = await fixture(t);
  const port = runtime.port, bearer = { authorization: 'Bearer ' + token }, json = { 'content-type': 'application/json' };
  // Anyone who can reach the port gets the empty page: no credential, no data, no cookie.
  const anonymous = await raw(port, '/');
  assert.equal(anonymous.status, 200); assert.match(anonymous.headers['content-type'], /text\/html/);
  assert.equal(anonymous.headers['set-cookie'], undefined); assert.equal(anonymous.text.includes(token), false);
  assert.equal((await raw(port, '/api/snapshot')).status, 401);
  assert.equal((await raw(port, '/api/session', { method: 'POST' })).status, 401, 'a sign-in link is minted only with the owner token');
  const issued = await raw(port, '/api/session', { method: 'POST', headers: bearer });
  assert.equal(issued.status, 200); assert.equal(issued.json.result.expiresInSeconds, 60);
  const link = new URL(issued.json.result.url), code = link.searchParams.get('code');
  assert.equal(link.origin, 'http://127.0.0.1:' + port);
  // Opening or previewing the link spends nothing and sets nothing: the page itself exchanges the code.
  const opened = await raw(port, link.pathname + link.search);
  assert.equal(opened.status, 200); assert.equal(opened.headers['set-cookie'], undefined); assert.equal(opened.headers.location, undefined);
  const exchange = (value, headers = {}) => raw(port, '/api/session/exchange', { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify({ code: value }) });
  assert.equal((await exchange('guess')).status, 401);
  assert.equal((await exchange(code, { origin: 'https://attacker.example' })).status, 403, 'another site cannot spend the code');
  const entered = await exchange(code);
  assert.equal(entered.status, 200); assert.equal(entered.headers['set-cookie'], undefined);
  const session = entered.json.result.session;
  assert.match(session, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(session, token);
  assert.equal((await exchange(code)).status, 401, 'the code works once');
  const snapshot = await raw(port, '/api/snapshot', { headers: { authorization: 'Bearer ' + session } });
  assert.equal(snapshot.status, 200); assert.equal(snapshot.json.result.viewer.role, 'owner');
  // A browser sends a cookie to every port of this host, so a cookie means nothing here; and a session cannot mint further sessions.
  assert.equal((await raw(port, '/api/snapshot', { headers: { cookie: 'devmate_session=' + session, 'sec-fetch-site': 'same-origin' } })).status, 401);
  assert.equal((await raw(port, '/api/session', { method: 'POST', headers: { authorization: 'Bearer ' + session } })).status, 403);
  assert.equal((await raw(port, '/', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  // A session belongs to one runtime generation: a made-up or outdated one means nothing.
  assert.equal((await raw(port, '/api/snapshot', { headers: { authorization: 'Bearer ' + 'A'.repeat(43) } })).status, 401);
});
test('the control API validates its envelope and answers with the right status', async t => {
  const { runtime, token, call } = await fixture(t);
  const post = body => raw(runtime.port, '/api/call', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body });
  for (const [body, code] of [['{}', 'invalid_input'], ['{"operation":7}', 'invalid_input'], ['{"operation":"project.list","input":[]}', 'invalid_input'], ['not json', 'invalid_input'], ['[]', 'invalid_input']]) {
    const response = await post(body);
    assert.equal(response.status, 400, body); assert.equal(response.json.error.code, code, body);
  }
  const unknown = await call('no.such.operation');
  assert.equal(unknown.status, 404); assert.equal(unknown.body.error.code, 'unknown_operation');
  const invalid = await call('project.create', { root: 7 });
  assert.equal(invalid.status, 400); assert.match(invalid.body.error.message, /Invalid input for project\.create: root/);
  assert.equal((await raw(runtime.port, '/nothing', { headers: { authorization: 'Bearer ' + token } })).status, 404);
});
test('auth:none MCP 2026 discovers and calls real project/file tools without private-control token', async t => {
  const { rpc, call, projectRoot, runtime } = await fixture(t);
  const discovery = await rpc('server/discover');
  assert.equal(discovery.status, 200, JSON.stringify(discovery.body));
  assert.ok(discovery.body.result.supportedVersions.includes(protocol));
  const tools = await rpc('tools/list');
  assert.equal(tools.status, 200, JSON.stringify(tools.body));
  // Which folders are shared is decided at the computer: there is no tool for it, and the generic call refuses it.
  for (const absent of ['project_create', 'runtime_stop', 'approval_resolve']) assert.equal(tools.body.result.tools.some(tool => tool.name === absent), false, absent);
  const attempt = await rpc('tools/call', { name: 'operations_call', arguments: { operation: 'project.create', input: { root: projectRoot } } });
  assert.equal(attempt.body.result.isError, true); assert.match(attempt.body.result.content[0].text, /shared by the owner on their own computer/);
  assert.equal(runtime.service.store.list('project').length, 0);
  const project = await call('project.create', { root: projectRoot });
  assert.equal(project.status, 200, JSON.stringify(project.body));
  const id = project.body.result.id;
  const write = await rpc('tools/call', { name: 'workspace_write', arguments: { projectId: id, path: 'hello.txt', text: 'real MCP file', expectedSha256: null } });
  assert.equal(write.body.result.structuredContent.written, true);
  const read = await rpc('tools/call', { name: 'workspace_read', arguments: { projectId: id, path: 'hello.txt' } });
  // A file is text for the model: one representation, with the hash to continue from on its last line.
  assert.equal(read.body.result.structuredContent, undefined);
  const lines = read.body.result.content[0].text.split('\n');
  assert.match(lines[0], /^\s+1\treal MCP file$/);
  assert.equal(JSON.parse(lines.at(-1)).sha256, write.body.result.structuredContent.sha256);
  assert.equal(runtime.service.store.list('project').length, 1);
  // The largest text the tool accepts fits in one request, also when its characters take several bytes each.
  const large = await rpc('tools/call', { name: 'workspace_write', arguments: { projectId: id, path: 'large.txt', text: '汉'.repeat(1_500_000), expectedSha256: null } });
  assert.equal(large.status, 200); assert.equal(large.body.result.structuredContent.written, true);
  // A resource that does not exist is answered with the code the specification requires, and names the resource.
  const uri = 'devmate://project/' + id + '/file/no-such-file.txt';
  const missing = await rpc('resources/read', { uri }, { 'mcp-name': uri });
  assert.equal(missing.body.error.code, -32602, JSON.stringify(missing.body)); assert.match(missing.body.error.data.uri, /no-such-file\.txt$/);
  // What a tool says about another tool uses the name the model can call.
  const described = Object.fromEntries(tools.body.result.tools.map(tool => [tool.name, tool.description]));
  assert.match(described.shell_run, /process_read/); assert.doesNotMatch(Object.values(described).join('\n'), /\b(process\.read|workspace\.read|agents\.result|workspace\.edit)\b(?!_)/);
});
test('a model sees a short tool list with readable titles and no idempotency key to misuse', async t => {
  const { rpc, call, projectRoot } = await fixture(t);
  const listed = (await rpc('tools/list')).body.result.tools;
  const named = name => listed.find(tool => tool.name === name);
  assert.ok(listed.length <= 40, 'only everyday tools and the workbench pair are listed: ' + listed.length);
  for (const hidden of ['workflow_create', 'task_create', 'approval_resolve', 'project_remove', 'job_start', 'settings_read', 'secret_set'])
    assert.equal(named(hidden), undefined, hidden + ' stays behind operations_call and the workbench');
  assert.equal(named('workspace_read').title, 'Read file');
  assert.equal(named('shell_run')._meta['openai/toolInvocation/invoking'], 'Running a command');
  for (const name of ['workspace_write', 'workspace_edit', 'shell_run', 'workspace_mkdir']) assert.equal(named(name).inputSchema.properties.operationId, undefined, name);
  const refused = await rpc('tools/call', { name: 'workspace_mkdir', arguments: { projectId: 'x', path: 'a', operationId: 'reused' } });
  assert.ok(refused.body.error || refused.body.result.isError, 'an idempotency key is not part of the model tool');
  // Everything else stays one call away.
  await call('project.create', { root: projectRoot });
  const summary = await rpc('tools/call', { name: 'operations_list', arguments: { summary: true } });
  assert.ok(summary.body.result.structuredContent.items.some(item => item.name === 'workflow.create'));
  const workflow = await rpc('tools/call', { name: 'operations_call', arguments: { operation: 'workflow.create', input: { title: 'Through the generic call' } } });
  assert.equal(workflow.body.result.structuredContent.title, 'Through the generic call');
  const decision = await rpc('tools/call', { name: 'operations_call', arguments: { operation: 'approval.resolve', input: { id: 'approval-x', optionId: 'allow' } } });
  assert.match(JSON.stringify(decision.body.result), /made by the user in the DevMate workbench/);
});
test('MCP refuses browser cross-origin access despite auth:none, and answers preflight for the headers clients send', async t => {
  const { rpc, runtime } = await fixture(t);
  const denied = await rpc('tools/list', {}, { origin: 'https://untrusted.example' });
  assert.equal(denied.status, 403, 'Cross-origin MCP request must be rejected before tool dispatch');
  const origin = 'http://127.0.0.1:' + runtime.port;
  const preflight = await raw(runtime.port, '/mcp', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST',
    'access-control-request-headers': 'mcp-method, mcp-name, mcp-param-path, mcp-protocol-version, x-evil' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers['access-control-allow-origin'], origin);
  const allowed = preflight.headers['access-control-allow-headers'].toLowerCase();
  for (const name of ['authorization', 'mcp-method', 'mcp-name', 'mcp-param-path', 'mcp-protocol-version']) assert.ok(allowed.includes(name), name);
  assert.equal(allowed.includes('x-evil'), false);
});
test('generation fencing rejects stale shutdown and normal stop releases the instance and its own files', async t => {
  const { runtime, instanceRoot } = await fixture(t);
  assert.throws(() => runtime.stop({ expectedGeneration: 'stale' }), { code: 'generation_mismatch' });
  assert.equal((await probeInstanceLock(instanceRoot)).generation, runtime.health.generation);
  await assert.rejects(startRuntime({ instanceRoot, port: 0, connectionFactory: localConnection }), { code: 'instance_running' });
  assert.equal(runtime.health.status, 'ready', 'a second start of the same instance changes nothing for the first');
  assert.equal(JSON.parse(fs.readFileSync(path.join(instanceRoot, 'runtime.json'), 'utf8')).generation, runtime.health.generation);
  await runtime.stop({ expectedGeneration: runtime.health.generation });
  assert.deepEqual(await probeInstanceLock(instanceRoot), { alive: false });
  assert.equal(fs.existsSync(path.join(instanceRoot, 'runtime.json')), false);
  assert.equal(fs.existsSync(path.join(instanceRoot, 'owner-token')), false);
});
test('invalid startup configuration leaves the instance free and the corrected instance starts', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-startup-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const configPath = path.join(temp, 'config.json');
  fs.writeFileSync(configPath, '{invalid');
  // The refusal names the file and says what to do, instead of a parser's or a schema's raw error.
  await assert.rejects(startRuntime({ instanceRoot: temp, port: 0, connectionFactory: localConnection }), error => error.code === 'invalid_config' && error.message.includes(configPath) && /not valid JSON/.test(error.message));
  assert.deepEqual(await probeInstanceLock(temp), { alive: false });
  fs.writeFileSync(configPath, JSON.stringify({ auth: { mode: 'unsupported' } }));
  await assert.rejects(startRuntime({ instanceRoot: temp, port: 0, connectionFactory: localConnection }), error => error.code === 'invalid_config' && /auth/.test(error.message) && /delete the file/.test(error.message));
  assert.deepEqual(await probeInstanceLock(temp), { alive: false });
  // Settings saved by a newer DevMate are recognised as that: the advice is to update, not to delete them.
  fs.writeFileSync(configPath, JSON.stringify({ writtenBy: '4.99.0', somethingNew: true }));
  await assert.rejects(startRuntime({ instanceRoot: temp, port: 0, connectionFactory: localConnection }), error => error.code === 'invalid_config' && /saved by DevMate 4\.99\.0/.test(error.message) && /Update this DevMate/.test(error.message));
  assert.deepEqual(await probeInstanceLock(temp), { alive: false });
  fs.unlinkSync(configPath);
  const runtime = await startRuntime({ instanceRoot: temp, port: 0, connectionFactory: localConnection });
  await runtime.stop();
});
test('a port taken by another program is named, and the instance stays free', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-port-'));
  const blocker = http.createServer((_req, res) => res.end('other'));
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => blocker.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); });
  const port = blocker.address().port;
  await assert.rejects(startRuntime({ instanceRoot: temp, port, connectionFactory: localConnection }),
    error => error.code === 'port_in_use' && error.message.includes(String(port)));
  assert.deepEqual(await probeInstanceLock(temp), { alive: false });
  assert.equal(fs.existsSync(path.join(temp, 'runtime.json')), false);
});
test('failure after connection start cleans runtime record, instance ownership and owned connection', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-startup-late-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  let stopped = 0;
  await assert.rejects(startRuntime({ instanceRoot: temp, port: 0,
    connectionFactory: () => ({ ...localConnection(), async stop() { stopped++; } }),
    onReady() { throw new Error('fixture readiness failure'); }
  }), /fixture readiness failure/);
  assert.deepEqual(await probeInstanceLock(temp), { alive: false });
  assert.equal(fs.existsSync(path.join(temp, 'runtime.json')), false);
  assert.equal(stopped, 1);
});
test('a connector that cannot start leaves local work running and is reported, never hidden', async t => {
  const failing = () => ({ ...localConnection(), async start() { throw Object.assign(new Error('Missing tunnel token'), { code: 'missing_credential' }); },
    status() { return { kind: 'cloudflare', phase: 'stopped' }; } });
  const { runtime, call, base } = await fixture(t, { connectionFactory: failing });
  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.status, 'ready'); assert.equal(health.connection, 'failed');
  assert.equal(JSON.stringify(health).includes('Missing tunnel token'), false, 'the reason is for the owner, not for anyone who can reach the port');
  const status = (await call('connection.status')).body.result;
  assert.equal(status.startError.code, 'missing_credential'); assert.equal(status.startError.message, 'Missing tunnel token');
  assert.equal((await call('project.list')).status, 200);
  assert.equal(runtime.health.status, 'ready');
});
