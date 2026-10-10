import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { startRuntime } from '../runtime/main.mjs';
import { verifyPublicMcp } from '../runtime/connection-verify.mjs';
import { createConnection, normalizeConnectionConfig } from '../runtime/connection.mjs';
import { normalizeConfig } from '../runtime/config.mjs';

const fakeConnection = kind => () => ({ async start() {}, async stop() {}, status() { return { kind, phase: 'fixture', remoteMcpVerified: false }; } });
function request(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.once('error', reject); req.end(body);
  });
}
async function fixture(t, config, kind = config.connection.kind) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-ingress-'));
  const instanceRoot = path.join(temp, 'instance'); fs.mkdirSync(instanceRoot);
  fs.writeFileSync(path.join(instanceRoot, 'config.json'), JSON.stringify(config));
  const runtime = await startRuntime({ instanceRoot, port: 0, connectionFactory: fakeConnection(kind) });
  t.after(async () => { await runtime.stop(); fs.rmSync(temp, { recursive: true, force: true }); });
  return { runtime, token: fs.readFileSync(path.join(instanceRoot, 'owner-token'), 'utf8') };
}
const publicHost = 'devmate.example.com';
const external = { connection: { kind: 'external-https', url: 'https://' + publicHost + '/mcp' } };

test('the public ingress port serves only MCP and never the owner control interface', async t => {
  const { runtime, token } = await fixture(t, external);
  assert.ok(runtime.ingressPort && runtime.ingressPort !== runtime.port);
  const viaProxy = { host: publicHost };
  for (const [pathname, options] of [['/', {}], ['/workbench', {}], ['/health', {}], ['/api/snapshot', { headers: { authorization: 'Bearer ' + token } }],
    ['/events', { headers: { authorization: 'Bearer ' + token } }],
    ['/api/call', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: '{"operation":"project.list"}' }]]) {
    const response = await request(runtime.ingressPort, pathname, { ...options, headers: { ...options.headers, ...viaProxy } });
    assert.equal(response.status, 404, pathname + ' must not exist on the ingress port');
    assert.equal(response.headers['set-cookie'], undefined, 'the ingress port never issues the owner cookie');
  }
  // A proxy that rewrites Host to loopback reaches nothing: neither listener trusts it.
  assert.equal((await request(runtime.ingressPort, '/mcp', { headers: { host: '127.0.0.1:' + runtime.ingressPort } })).status, 421);
  assert.equal((await request(runtime.ingressPort, '/mcp', { headers: { host: 'attacker.example' } })).status, 421);
  const listed = await request(runtime.ingressPort, '/mcp', { method: 'OPTIONS', headers: viaProxy });
  assert.equal(listed.status, 204, 'MCP itself is served for the configured public host');
});

test('the control port refuses public hosts and any request that arrived through a proxy', async t => {
  const { runtime, token } = await fixture(t, external);
  assert.equal((await request(runtime.port, '/mcp', { method: 'OPTIONS', headers: { host: publicHost } })).status, 421);
  for (const header of ['x-forwarded-for', 'cf-connecting-ip', 'forwarded', 'x-real-ip']) {
    const forwarded = await request(runtime.port, '/', { headers: { [header]: '203.0.113.9' } });
    assert.equal(forwarded.status, 421, header); assert.equal(forwarded.json.error.code, 'forwarded_request');
    assert.equal(forwarded.headers['set-cookie'], undefined, 'a proxied request never receives the owner cookie');
  }
  const local = await request(runtime.port, '/api/snapshot', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(local.status, 200);
  assert.equal((await request(runtime.port, '/health')).json.ingressPort, runtime.ingressPort);
});

test('a purely local runtime opens no ingress listener at all', async t => {
  const { runtime } = await fixture(t, {}, 'local');
  assert.equal(runtime.ingressPort, null); assert.equal(runtime.ingress.listening, false);
  assert.equal((await request(runtime.port, '/health')).json.ingressPort, undefined);
});

test('verification is a real MCP round trip that must reach this exact runtime', async t => {
  // An OpenAI tunnel client forwards to the loopback ingress port, which lets the probe run without a public network.
  const tunnel = { connection: { kind: 'openai-tunnel', tunnelId: 'tunnel_abc123', executable: process.execPath } };
  const { runtime } = await fixture(t, tunnel);
  const url = 'http://127.0.0.1:' + runtime.ingressPort + '/mcp';
  const generation = runtime.health.generation;
  const verified = await verifyPublicMcp({ url, expectedGeneration: generation });
  assert.equal(verified.verified, true, JSON.stringify(verified)); assert.ok(verified.tools > 20);
  const other = await verifyPublicMcp({ url, expectedGeneration: 'another-runtime' });
  assert.deepEqual([other.verified, other.reachable], [false, true]); assert.match(other.reason, /different DevMate runtime/);
  const dead = await verifyPublicMcp({ url: 'http://127.0.0.1:1/mcp', expectedGeneration: generation, timeoutMs: 3000 });
  assert.deepEqual([dead.verified, dead.reachable], [false, false]);
  // Without a public URL there is nothing to probe, and the status says so instead of claiming success.
  const unverifiable = await runtime.service.verifyConnection();
  assert.equal(unverifiable.verified, false); assert.match(unverifiable.reason, /from ChatGPT/);
  const owner = { id: 'owner', role: 'owner', surface: 'local' };
  const status = await runtime.service.call('connection.status', {}, owner);
  assert.equal(status.remoteMcpVerified, false); assert.equal(status.instance.generation, generation);
  await assert.rejects(runtime.service.call('connection.verify', {}, { id: 'owner', role: 'owner' }), { code: 'forbidden' });
});

test('service records a successful public verification and reports it in connection status', async t => {
  const calls = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-verify-'));
  const { DevMateService } = await import('../runtime/service.mjs');
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '', config: external,
    verifier: async input => { calls.push(input); return { verified: true, reachable: true, tools: 60 }; } });
  await service.ready; service.identity = { instanceId: 'i', generation: 'g' };
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const owner = { id: 'owner', role: 'owner', surface: 'local' };
  const result = await service.call('connection.verify', {}, owner);
  assert.equal(result.verified, true); assert.equal(result.url, 'https://' + publicHost + '/mcp');
  assert.deepEqual(calls, [{ url: 'https://' + publicHost + '/mcp', authMode: 'none', expectedGeneration: 'g' }]);
  assert.equal((await service.call('connection.status', {}, owner)).remoteMcpVerified, true);
});

test('cloudflare connection keeps the token out of arguments, reports edge registration and restarts only its own process', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-cloudflare-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const config = { kind: 'cloudflare', publicUrl: 'https://' + publicHost + '/mcp', executable: process.execPath };
  assert.deepEqual(normalizeConnectionConfig(config), { ...config, tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN' });
  assert.throws(() => normalizeConnectionConfig({ ...config, publicUrl: 'http://' + publicHost + '/mcp' }), { code: 'invalid_connection' });
  assert.throws(() => normalizeConnectionConfig({ ...config, publicUrl: 'https://' + publicHost + '/' }), { code: 'invalid_connection' });
  assert.throws(() => normalizeConnectionConfig({ ...config, executable: 'cloudflared.cmd' }), { code: 'invalid_executable' });
  assert.throws(() => normalizeConnectionConfig({ ...config, token: 'inline-secret' }), { code: 'invalid_connection' });
  assert.equal(normalizeConfig({ connection: config, ingressPort: 8789 }).ingressPort, 8789);
  const spawned = [];
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter(); child.pid = 4242 + spawned.length; child.exitCode = null; child.signalCode = null; child.stderr = new EventEmitter();
    spawned.push({ file, args, options, child }); queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const terminateImpl = async child => { child.exitCode = 0; child.emit('exit', 0, null); return { exitConfirmed: true }; };
  const missing = createConnection({ config, localMcpUrl: 'http://127.0.0.1:8789/mcp', instanceRoot: temp, env: {}, spawnImpl, terminateImpl });
  await assert.rejects(missing.start(), { code: 'missing_credential' }); assert.equal(spawned.length, 0);
  let ready = null; const asked = [];
  const fetchImpl = async url => { asked.push(String(url)); if (!ready) throw new Error('unreachable'); return { ok: ready.ok, json: async () => ready.body }; };
  // A credential stored after the first failed start applies on the next start of the connector.
  missing.refresh({ CLOUDFLARE_TUNNEL_TOKEN: 'stored-later' });
  assert.equal((await missing.start()).phase, 'connecting'); assert.equal(spawned.pop().options.env.TUNNEL_TOKEN, 'stored-later');
  await missing.stop();
  const connection = createConnection({ config, localMcpUrl: 'http://127.0.0.1:8789/mcp', instanceRoot: temp,
    env: { CLOUDFLARE_TUNNEL_TOKEN: 'secret-token', PATH: 'x', GITHUB_TOKEN: 'unrelated' }, spawnImpl, terminateImpl, fetchImpl });
  const started = await connection.start();
  assert.equal(started.phase, 'connecting'); assert.equal(started.routeService, 'http://127.0.0.1:8789'); assert.equal(started.remoteMcpVerified, false);
  // Its own metrics server is pinned to loopback instead of the default that may bind every interface.
  assert.deepEqual(spawned[0].args, ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:0', 'run']);
  assert.equal(JSON.stringify(spawned[0].args).includes('secret-token'), false);
  assert.equal(spawned[0].options.env.TUNNEL_TOKEN, 'secret-token'); assert.equal(spawned[0].options.env.GITHUB_TOKEN, undefined, 'unrelated credentials are not forwarded');
  assert.equal(spawned[0].options.shell, false);
  spawned[0].child.stderr.emit('data', 'INF Registered tunnel connection connIndex=0\nINF Registered tunnel connection connIndex=1\n');
  const state = async () => { const status = await connection.status(); return [status.phase, status.edgeConnections]; };
  assert.deepEqual(await state(), ['connected', 2]);
  // Losing the edge is noticed from the log, and exactly from cloudflared's own readiness endpoint once it is announced.
  spawned[0].child.stderr.emit('data', 'WRN Unregistered tunnel connection connIndex=0\nWRN Unregistered tunnel connection connIndex=1\n');
  assert.deepEqual(await state(), ['connecting', 0]);
  spawned[0].child.stderr.emit('data', 'INF Starting metrics server on 127.0.0.1:20241/metrics\n');
  ready = { ok: true, body: { status: 200, readyConnections: 4 } };
  assert.deepEqual(await state(), ['connected', 4]); assert.deepEqual(asked, ['http://127.0.0.1:20241/ready']);
  ready = { ok: false, body: { status: 503, readyConnections: 0 } };
  assert.deepEqual(await state(), ['connecting', 0]);
  ready = null;
  assert.deepEqual(await state(), ['connecting', 0], 'an unreachable readiness endpoint changes nothing');
  spawned[0].child.exitCode = 1; spawned[0].child.emit('exit', 1, null);
  assert.equal((await connection.status()).phase, 'failed'); assert.equal((await connection.status()).retryScheduled, true);
  const stopped = await connection.stop();
  assert.equal(stopped.phase, 'stopped'); assert.equal(stopped.retryScheduled, false, 'an explicit stop cancels the pending restart');
});

test('a quick tunnel needs no credential, takes the address it is given and loses it with the connector', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-quick-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const config = { kind: 'cloudflare-quick', executable: process.execPath };
  assert.deepEqual(normalizeConnectionConfig(config), config);
  assert.throws(() => normalizeConnectionConfig({ ...config, publicUrl: 'https://x.example/mcp' }), { code: 'invalid_connection' });
  assert.throws(() => normalizeConnectionConfig({ ...config, executable: 'cloudflared' }), { code: 'invalid_executable' });
  // Nobody can sign in at an address that is new with every start.
  assert.throws(() => normalizeConfig({ connection: config, auth: { mode: 'oauth', issuer: 'https://x.example' } }), { code: 'invalid_issuer' });
  assert.equal(normalizeConfig({ connection: config }).auth.mode, 'none');
  const spawned = [];
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter(); child.pid = 5151 + spawned.length; child.exitCode = null; child.signalCode = null; child.stderr = new EventEmitter();
    spawned.push({ file, args, options, child }); queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const terminateImpl = async child => { child.exitCode = 0; child.emit('exit', 0, null); return { exitConfirmed: true }; };
  const connection = createConnection({ config, localMcpUrl: 'http://127.0.0.1:8789/mcp', instanceRoot: temp, env: { PATH: 'x', GITHUB_TOKEN: 'unrelated' }, spawnImpl, terminateImpl,
    fetchImpl: async () => { throw new Error('unreachable'); } });
  const started = await connection.start();
  assert.equal(started.phase, 'connecting'); assert.equal(started.publicUrl, undefined); assert.equal(started.temporaryAddress, true); assert.equal(connection.publicUrl(), null);
  // It is told where to forward to, and carries no token and nothing else of the runtime's.
  assert.deepEqual(spawned[0].args, ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:0', '--url', 'http://127.0.0.1:8789']);
  assert.equal(spawned[0].options.env.TUNNEL_TOKEN, undefined); assert.equal(spawned[0].options.env.GITHUB_TOKEN, undefined); assert.equal(spawned[0].options.shell, false);
  spawned[0].child.stderr.emit('data', 'INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\nINF |  https://calm-river-quick-fixture.trycloudflare.com  |\n');
  spawned[0].child.stderr.emit('data', 'INF Registered tunnel connection connIndex=0\n');
  const live = await connection.status();
  assert.equal(live.phase, 'connected'); assert.equal(live.publicUrl, 'https://calm-river-quick-fixture.trycloudflare.com/mcp');
  assert.equal(connection.publicUrl(), 'https://calm-river-quick-fixture.trycloudflare.com/mcp');
  await connection.stop();
  assert.equal(connection.publicUrl(), null, 'a stopped tunnel has no address');
  assert.equal((await connection.status()).publicUrl, undefined);
});

test('the ingress answers a quick tunnel only under the address the tunnel holds right now', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-quick-ingress-'));
  const instanceRoot = path.join(temp, 'instance'); fs.mkdirSync(instanceRoot);
  fs.writeFileSync(path.join(instanceRoot, 'config.json'), JSON.stringify({ connection: { kind: 'cloudflare-quick', executable: process.execPath } }));
  let address = null;
  const runtime = await startRuntime({ instanceRoot, port: 0, connectionFactory: () => ({ async start() {}, async stop() {}, publicUrl: () => address,
    status() { return { kind: 'cloudflare-quick', phase: address ? 'connected' : 'connecting', ...(address ? { publicUrl: address } : {}), remoteMcpVerified: false }; } }) });
  t.after(async () => { await runtime.stop(); fs.rmSync(temp, { recursive: true, force: true }); });
  assert.ok(runtime.ingressPort, 'the ingress listens before the address is known');
  const ask = host => request(runtime.ingressPort, '/mcp', { method: 'OPTIONS', headers: { host } });
  assert.equal((await ask('first-fixture.trycloudflare.com')).status, 421, 'no address yet: nothing is served');
  address = 'https://first-fixture.trycloudflare.com/mcp';
  assert.equal((await ask('first-fixture.trycloudflare.com')).status, 204);
  assert.equal((await ask('someone-else.trycloudflare.com')).status, 421);
  // The tunnel started again: the old address is refused at once, the new one is served.
  address = 'https://second-fixture.trycloudflare.com/mcp';
  assert.equal((await ask('first-fixture.trycloudflare.com')).status, 421);
  assert.equal((await ask('second-fixture.trycloudflare.com')).status, 204);
  assert.equal(runtime.service.publicUrl(), address);
  const doctor = await runtime.service.call('runtime.doctor', {}, { id: 'owner', role: 'owner', surface: 'local' });
  const named = id => doctor.checks.find(item => item.id === id);
  assert.equal(named('connection.address').status, 'info'); assert.match(named('connection.address').detail, /changes whenever/);
  assert.match(named('security').detail, /quick tunnel address has no sign-in/); assert.doesNotMatch(named('security').fix, /oauth/);
});