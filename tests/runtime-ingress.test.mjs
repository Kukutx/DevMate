import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startRuntime } from '../runtime/main.mjs';
import { verifyPublicMcp } from '../runtime/connection-verify.mjs';
import { createConnection, normalizeConnectionConfig } from '../runtime/connection.mjs';
import { normalizeConfig } from '../runtime/config.mjs';
import { forgetQuickTunnelKey } from '../runtime/cloudflare-connection.mjs';

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
  // The refusal says which host the request named and what a proxy has to pass on, and not the address itself:
  // without sign-in that address is all that keeps a stranger out, and a page of any site can ask this port.
  const foreign = await request(runtime.ingressPort, '/mcp', { headers: { host: 'attacker.example' } });
  assert.equal(foreign.status, 421);
  assert.equal(foreign.json.error.message, 'This request names the host attacker.example, which is not the public address of this DevMate (devmate mcp-url shows it). A proxy in front of DevMate has to pass the public host name on: nginx "proxy_set_header Host $host;", Apache "ProxyPreserveHost On".');
  assert.equal(foreign.text.split(publicHost).length, 1, 'the public host is nowhere in the answer');
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
  assert.equal(verified.verified, true, JSON.stringify(verified)); assert.ok(verified.tools > 10);
  const other = await verifyPublicMcp({ url, expectedGeneration: 'another-runtime' });
  assert.deepEqual([other.verified, other.reachable], [false, true]); assert.match(other.reason, /different DevMate runtime/);
  const dead = await verifyPublicMcp({ url: 'http://127.0.0.1:1/mcp', expectedGeneration: generation, timeoutMs: 3000 });
  assert.deepEqual([dead.verified, dead.reachable], [false, false]);
  // Without a public URL there is nothing to probe, and the status says so instead of claiming success.
  const unverifiable = await runtime.service.verifyConnection();
  assert.equal(unverifiable.verified, false); assert.match(unverifiable.reason, /from ChatGPT/);
  const owner = { id: 'owner', surface: 'local' };
  const status = await runtime.service.call('connection.status', {}, owner);
  assert.equal(status.remoteMcpVerified, false); assert.equal(status.instance.generation, generation);
  await assert.rejects(runtime.service.call('connection.verify', {}, { id: 'owner' }), { code: 'forbidden' });
});

test('service records a successful public verification and reports it in connection status', async t => {
  const calls = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-verify-'));
  const { DevMateService } = await import('../runtime/service.mjs');
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '', config: external,
    verifier: async input => { calls.push(input); return { verified: true, reachable: true, tools: 60 }; } });
  await service.ready; service.identity = { instanceId: 'i', generation: 'g' };
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const owner = { id: 'owner', surface: 'local' };
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

// A cloudflared as a quick tunnel's connector is seen from the runtime: a process, and its metrics server (the address
// it was given, how many connections to Cloudflare it holds). given: the host name it holds; ready: its connections.
function quickFixture() {
  // events: what was done to connectors, in order ('reap' of one written down, 'spawn' of a new one).
  const spawned = [], events = [], cloudflared = { given: null, ready: 0, answers: true };
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter(); child.pid = 5151 + spawned.length; child.exitCode = null; child.signalCode = null; child.unref = () => { child.unrefd = true; };
    spawned.push({ file, args, options, child }); events.push('spawn'); queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const terminated = [];
  const terminateImpl = async child => { terminated.push(child.pid); child.exitCode = 0; child.emit('exit', 0, null); return { exitConfirmed: true }; };
  const fetchImpl = async address => {
    if (!cloudflared.answers) throw new Error('connection refused');
    const body = address.endsWith('/quicktunnel') ? { hostname: cloudflared.given || '' } : { status: cloudflared.ready ? 200 : 503, readyConnections: cloudflared.ready };
    return { ok: !address.endsWith('/ready') || cloudflared.ready > 0, json: async () => body };
  };
  // The record of a kept connector, as ownedProcess keeps it in a file: here in memory, with a process that is alive
  // for as long as `alive` says. refused: the system does not say who the process is, and nothing is written.
  const kept = { record: null, alive: true, reaped: 0, refused: false };
  const owned = {
    async remember(pid, about = {}, still = () => true) { if (kept.refused || !still()) return false; kept.record = { ...about, pid, identity: 'cloudflared|' + pid }; return true; },
    async adopt(fits = () => true) { return kept.record && kept.alive && fits(kept.record) ? kept.record : null; },
    amend(pid, fields) { if (kept.record?.pid !== pid) return false; kept.record = { ...kept.record, ...fields }; kept.amended = (kept.amended || 0) + 1; return true; },
    async reap() { if (kept.record) { kept.reaped++; events.push('reap'); } kept.record = null; return { reaped: true }; },
    forget() { kept.record = null; }
  };
  return { spawned, events, cloudflared, spawnImpl, terminateImpl, terminated, fetchImpl, kept, owned };
}
const until = async (check, what, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 20))) if (await check()) return; throw new Error('Timed out waiting for ' + what); };

test('a quick tunnel needs no credential, takes the address it is given, and its connector is a process of its own that a restart leaves running', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-quick-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const config = { kind: 'cloudflare-quick', executable: process.execPath };
  assert.deepEqual(normalizeConnectionConfig(config), config);
  assert.throws(() => normalizeConnectionConfig({ ...config, publicUrl: 'https://x.example/mcp' }), { code: 'invalid_connection' });
  assert.throws(() => normalizeConnectionConfig({ ...config, executable: 'cloudflared' }), { code: 'invalid_executable' });
  // Nobody can sign in at an address that changes when cloudflared starts again.
  assert.throws(() => normalizeConfig({ connection: config, auth: { mode: 'oauth', issuer: 'https://x.example' } }), { code: 'invalid_issuer' });
  assert.equal(normalizeConfig({ connection: config }).auth.mode, 'none');
  const { spawned, cloudflared, spawnImpl, terminateImpl, terminated, fetchImpl, kept, owned } = quickFixture();
  const connect = () => createConnection({ config, localMcpUrl: 'http://127.0.0.1:8789/mcp/key-of-this-start', instanceRoot: temp, env: { PATH: 'x', GITHUB_TOKEN: 'unrelated' }, spawnImpl, terminateImpl, fetchImpl, owned, pickPort: async () => 47011 });
  const connection = connect();
  const started = await connection.start();
  assert.equal(started.phase, 'connecting'); assert.equal(started.publicUrl, undefined); assert.equal(started.temporaryAddress, true); assert.equal(connection.publicUrl(), null);
  // It is told where to forward to, where its metrics are and where it writes its log, and carries no token and
  // nothing else of the runtime's: the key is never on its command line.
  assert.deepEqual(spawned[0].args, ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:47011', '--logfile', path.join(temp, 'quick-tunnel.log'), '--url', 'http://127.0.0.1:8789']);
  assert.equal(spawned[0].options.env.TUNNEL_TOKEN, undefined); assert.equal(spawned[0].options.env.GITHUB_TOKEN, undefined); assert.equal(spawned[0].options.shell, false);
  // A process of its own, holding nothing of the runtime's open, with no window: it outlives the runtime.
  assert.deepEqual([spawned[0].options.detached, spawned[0].options.stdio, spawned[0].options.windowsHide, spawned[0].child.unrefd], [true, 'ignore', true, true]);
  // Written down at once, before its address is known: a runtime that stops now leaves no connector nobody knows of.
  assert.deepEqual({ ...kept.record, identity: undefined }, { kind: 'cloudflare-quick', executable: process.execPath, forwardsTo: 8789, keyId: kept.record.keyId, metrics: 'http://127.0.0.1:47011', pid: 5151, identity: undefined });
  assert.ok(!JSON.stringify(kept.record).includes('key-of-this-start'), 'only a sign of the key is written down');
  // The address is what cloudflared says it was given, plus the path this runtime answers under.
  cloudflared.given = 'calm-river-quick-fixture.trycloudflare.com'; cloudflared.ready = 2;
  await until(() => connection.publicUrl(), 'the address to be learned');
  const live = await connection.status();
  assert.equal(live.phase, 'connected'); assert.equal(live.edgeConnections, 2); assert.equal(live.publicUrl, 'https://calm-river-quick-fixture.trycloudflare.com/mcp/key-of-this-start');
  assert.ok(Date.parse(live.addressSince) > 0);
  await until(() => kept.record?.since, 'the time of the address to be written down');
  // Added to what was written down at the start, at once (a restart in the seconds a second asking takes kept a record
  // without it: found with the real cloudflared).
  assert.equal(kept.amended, 1);
  // cloudflared writes the address a failed request went to into its log, key and all: what is shown of the log
  // (connection.status, the doctor) has the key taken out.
  fs.writeFileSync(path.join(temp, 'quick-tunnel.log'), 'INF started\nERR Request failed error="no answer" dest=https://calm-river-quick-fixture.trycloudflare.com/mcp/key-of-this-start?x=1 connIndex=0\n');
  const logged = (await connection.status()).diagnostic;
  assert.match(logged, /dest=https:\/\/calm-river-quick-fixture\.trycloudflare\.com\/mcp\/<key>\?x=1/); assert.ok(!logged.includes('key-of-this-start'));
  // Also where what is shown of the log begins inside "/mcp/" (cut first, the key was left whole there).
  for (const into of [1, 2, 3, 4, 5]) {
    const address = '/mcp/key-of-this-start\n';
    fs.writeFileSync(path.join(temp, 'quick-tunnel.log'), 'x'.repeat(5000) + address + 'y'.repeat(4000 - (address.length - into)));
    assert.ok(!(await connection.status()).diagnostic.includes('key-of-this-start'), 'cut ' + into + ' characters into the address');
  }
  // A restart (or a runtime that fails) leaves it running, written down; the next runtime takes it back, address and all.
  await connection.stop({ keep: true });
  assert.deepEqual(terminated, []); assert.equal(connection.publicUrl(), null); assert.ok(kept.record);
  const next = connect();
  const taken = await next.start();
  assert.equal(spawned.length, 1, 'no second cloudflared'); assert.equal(taken.adopted, true);
  assert.equal(next.publicUrl(), 'https://calm-river-quick-fixture.trycloudflare.com/mcp/key-of-this-start');
  assert.equal(taken.addressSince, live.addressSince, 'its address is the one it has had since then');
  // An explicit stop ends it, also one that was taken back.
  await next.stop();
  assert.equal(kept.reaped, 1); assert.equal(kept.record, null); assert.equal(next.publicUrl(), null);
  assert.equal((await next.status()).publicUrl, undefined);
  // And a stop of a connector this runtime started ends it as ever.
  const third = connect(); await third.start(); await third.stop();
  assert.deepEqual(terminated, [spawned[1].child.pid]);
  // One that could not be written down (the system did not say who the process is) is not left running by a restart:
  // nobody could find it again to end it.
  kept.refused = true;
  const fourth = connect(); await fourth.start(); await fourth.stop({ keep: true });
  assert.deepEqual(terminated, [spawned[1].child.pid, spawned[2].child.pid]);
});

test('a kept quick tunnel that does not answer for a moment keeps its address while its process is there, and one whose process is gone is started again', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-quick-busy-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const config = { kind: 'cloudflare-quick', executable: process.execPath };
  const { spawned, cloudflared, spawnImpl, terminateImpl, fetchImpl, kept, owned } = quickFixture();
  const connect = (more = {}) => createConnection({ config, localMcpUrl: 'http://127.0.0.1:8789/mcp/key-of-this-start', instanceRoot: temp, env: { PATH: 'x' }, spawnImpl, terminateImpl, fetchImpl, owned, pickPort: async () => 47011, ...more });
  cloudflared.given = 'busy-fixture.trycloudflare.com'; cloudflared.ready = 1;
  const first = connect(); await first.start(); await until(() => first.publicUrl(), 'the address'); await until(() => kept.record?.since, 'the record');
  await first.stop({ keep: true });
  const taken = connect({ lookMs: 20 }); assert.equal((await taken.start()).adopted, true);
  // A computer under load: cloudflared answers nothing for a while, and its process is still the one written down.
  cloudflared.answers = false;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(spawned.length, 1, 'it is not taken for gone'); assert.equal(taken.publicUrl(), 'https://busy-fixture.trycloudflare.com/mcp/key-of-this-start');
  // Its process is gone: it is started again.
  kept.alive = false;
  await until(async () => (await taken.status()).error?.code === 'cloudflared_exited', 'the end to be said');
  await until(() => spawned.length === 2, 'a new cloudflared', 5000);
  cloudflared.answers = true; await taken.stop();
});

test('a kept quick tunnel is taken back only where it is still the one this runtime would start, and one that lost its way is started again', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-quick-kept-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const config = { kind: 'cloudflare-quick', executable: process.execPath };
  const { spawned, events, cloudflared, spawnImpl, terminateImpl, fetchImpl, kept, owned } = quickFixture();
  const connect = (localMcpUrl = 'http://127.0.0.1:8789/mcp/key-of-this-start', more = {}) => createConnection({ config, localMcpUrl, instanceRoot: temp, env: { PATH: 'x' }, spawnImpl, terminateImpl, fetchImpl, owned, pickPort: async () => 47011, ...more });
  cloudflared.given = 'first-fixture.trycloudflare.com'; cloudflared.ready = 1;
  const first = connect(); await first.start(); await until(() => first.publicUrl(), 'the first address'); await until(() => kept.record?.since, 'the record');
  await first.stop({ keep: true });
  // Another port to forward to, another key (the owner asked for a new address), or a connector that is not there
  // any more: it is not taken back; what is written down is ended, and a new one is started. (Each differs from the
  // one kept before it in that one thing only.)
  for (const [why, url, prepare] of [['another port', 'http://127.0.0.1:9790/mcp/key-of-this-start', () => {}], ['another key', 'http://127.0.0.1:9790/mcp/a-new-key-of-the-owner', () => {}],
    ['gone', 'http://127.0.0.1:9790/mcp/a-new-key-of-the-owner', () => { kept.alive = false; }]]) {
    prepare();
    const before = spawned.length, reaped = kept.reaped, other = connect(url);
    await other.start();
    assert.equal(spawned.length, before + 1, why + ': a new cloudflared');
    assert.equal(kept.reaped, reaped + 1, why + ': what was written down is ended');
    assert.deepEqual(events.slice(-2), ['reap', 'spawn'], why + ': ended before the new one starts');
    await until(() => other.publicUrl(), why + ': its address'); await until(() => kept.record?.since, why + ': its record');
    await other.stop({ keep: true }); kept.alive = true;
  }
  // A kept connector that answers late when asked for its address (a restart, on a busy computer) is taken back: it is
  // given a while. (The same one the last round kept: everything else about it fits.)
  const same = 'http://127.0.0.1:9790/mcp/a-new-key-of-the-owner';
  cloudflared.answers = false; setTimeout(() => { cloudflared.answers = true; }, 300);
  const late = connect(same, { adoptMs: 3000 });
  assert.equal((await late.start()).adopted, true); assert.equal(spawned.length, 4);
  await late.stop({ keep: true });
  // One that does not answer within that while is not taken back: what is written down is ended, and a new one started.
  cloudflared.answers = false;
  const reapedBefore = kept.reaped, silent = connect(same, { adoptMs: 100 }); await silent.start();
  assert.equal(silent.publicUrl(), null); assert.equal(spawned.length, 5); assert.equal(kept.reaped, reapedBefore + 1); assert.deepEqual(events.slice(-2), ['reap', 'spawn']);
  cloudflared.answers = true; await silent.stop();
  // One that holds no connection to Cloudflare for the time allowed (a long time offline) is ended and started again:
  // its address may be gone, and a new one is said as new. Only time this runtime was awake to look counts.
  let clock = Date.now();
  const watched = connect(undefined, { lookMs: 20, lostMs: 1000, now: () => clock });
  await watched.start(); await until(() => watched.publicUrl(), 'the address of the watched one');
  const before = spawned.length;
  cloudflared.ready = 0; clock += 500;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(spawned.length, before, 'a moment without a connection is no loss');
  // The computer slept: between two looks the clock went on far more than a look takes. That time is not counted.
  clock += 5000;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(spawned.length, before, 'a sleep is no loss'); assert.equal((await watched.status()).error, undefined);
  // Awake and looking all along: lost. Said as lost (until the new one starts, a second later), then started again.
  const ticking = setInterval(() => { clock += 10; }, 10);
  try { await until(async () => (await watched.status()).error?.code === 'tunnel_lost', 'the loss to be said', 8000); } finally { clearInterval(ticking); }
  assert.equal(watched.publicUrl(), null, 'a lost tunnel has no address');
  await until(() => spawned.length === before + 1, 'a new cloudflared after the tunnel was lost', 5000);
  cloudflared.ready = 1;
  await watched.stop();
});

test('a quick tunnel that does not answer at all for the time allowed is stuck, and started again; one the system cannot say anything about is left as it is', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-quick-stuck-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const config = { kind: 'cloudflare-quick', executable: process.execPath };
  const { spawned, events, cloudflared, spawnImpl, terminateImpl, terminated, fetchImpl, kept, owned } = quickFixture();
  const connect = (more = {}) => createConnection({ config, localMcpUrl: 'http://127.0.0.1:8789/mcp/key-of-this-start', instanceRoot: temp, env: { PATH: 'x' }, spawnImpl, terminateImpl, fetchImpl, owned, pickPort: async () => 47011, ...more });
  cloudflared.given = 'stuck-fixture.trycloudflare.com'; cloudflared.ready = 1;
  let clock = Date.now();
  // (A connector of another connection that a killed runtime left behind is ended before a quick tunnel starts.)
  const leftovers = [], leftover = { async reap() { leftovers.push('reap'); return { reaped: true }; } };
  const stuck = connect({ lookMs: 20, lostMs: 300, now: () => clock, leftover });
  await stuck.start(); await until(() => stuck.publicUrl(), 'the address'); assert.deepEqual(leftovers, ['reap']);
  // Its log, which it writes for as long as it runs, is put aside past its size.
  const log = path.join(temp, 'quick-tunnel.log');
  fs.writeFileSync(log, 'a line of the log\n'.repeat(70000));
  await until(() => fs.statSync(log).size === 0, 'the log to be put aside');
  assert.equal(fs.statSync(log + '.1').size, 'a line of the log\n'.length * 70000);
  cloudflared.answers = false;
  const ticking = setInterval(() => { clock += 10; }, 10);
  try { await until(async () => (await stuck.status()).error?.code === 'tunnel_stuck', 'it to be said stuck', 8000); } finally { clearInterval(ticking); }
  assert.deepEqual(terminated, [spawned[0].child.pid]);
  cloudflared.answers = true; await until(() => spawned.length === 2, 'a new cloudflared', 5000); await stuck.stop();
  // Where the system cannot say whether the process written down is still the one (asking it took too long), it is
  // neither taken back, nor ended, nor forgotten, and no second tunnel is started beside it.
  kept.record = { kind: 'cloudflare-quick', pid: 77, identity: 'cloudflared|77' };
  const unknown = Object.assign(new Error('The system could not say'), { code: 'identity_unknown' });
  const asked = { ...owned, async adopt() { throw unknown; }, async reap() { throw unknown; } };
  const before = [spawned.length, events.length];
  await assert.rejects(createConnection({ config, localMcpUrl: 'http://127.0.0.1:8789/mcp/key-of-this-start', instanceRoot: temp, env: { PATH: 'x' }, spawnImpl, terminateImpl, fetchImpl, owned: asked, pickPort: async () => 47011 }).start(), { code: 'identity_unknown' });
  assert.deepEqual([spawned.length, events.length], before); assert.equal(kept.record.pid, 77);
});

test('the ingress answers a quick tunnel only under the address the tunnel holds right now', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-quick-ingress-'));
  const instanceRoot = path.join(temp, 'instance'); fs.mkdirSync(instanceRoot);
  fs.writeFileSync(path.join(instanceRoot, 'config.json'), JSON.stringify({ connection: { kind: 'cloudflare-quick', executable: process.execPath } }));
  let address = null, keyPath = null;
  const runtime = await startRuntime({ instanceRoot, port: 0, connectionFactory: ({ localMcpUrl }) => { keyPath = new URL(localMcpUrl).pathname; return { async start() {}, async stop() {}, publicUrl: () => address,
    status() { return { kind: 'cloudflare-quick', phase: address ? 'connected' : 'connecting', ...(address ? { publicUrl: address } : {}), remoteMcpVerified: false }; } }; } });
  t.after(async () => { await runtime.stop(); fs.rmSync(temp, { recursive: true, force: true }); });
  assert.ok(runtime.ingressPort, 'the ingress listens before the address is known');
  // The host name of a quick tunnel is visible to anyone who watches DNS. What opens the endpoint is the rest of the address.
  assert.match(keyPath, /^\/mcp\/[A-Za-z0-9_-]{32}$/);
  const ask = (host, pathname = keyPath) => request(runtime.ingressPort, pathname, { method: 'OPTIONS', headers: { host } });
  const early = await request(runtime.ingressPort, keyPath, { headers: { host: 'first-fixture.trycloudflare.com' } });
  assert.equal(early.status, 421, 'no address yet: nothing is served');
  // And said as that: there is no public address and no proxy to speak of yet.
  assert.equal(early.json.error.message, 'This request names the host first-fixture.trycloudflare.com. This DevMate has no public address at the moment, so nothing is answered on this port under that name (the quick tunnel has not been given its address yet: try again in a few seconds).');
  address = 'https://first-fixture.trycloudflare.com' + keyPath;
  assert.equal((await ask('first-fixture.trycloudflare.com')).status, 204);
  assert.equal((await ask('someone-else.trycloudflare.com')).status, 421);
  for (const guess of ['/mcp', '/mcp/', '/mcp/' + 'A'.repeat(32), keyPath.slice(0, -1), keyPath + '/', '/']) {
    assert.equal((await ask('first-fixture.trycloudflare.com', guess)).status, 404, guess + ' is not the address');
  }
  // The tunnel started again: the old address is refused at once, the new one is served.
  address = 'https://second-fixture.trycloudflare.com' + keyPath;
  assert.equal((await ask('first-fixture.trycloudflare.com')).status, 421);
  assert.equal((await ask('second-fixture.trycloudflare.com')).status, 204);
  assert.equal(runtime.service.publicUrl(), address);
  const doctor = await runtime.service.call('runtime.doctor', {}, { id: 'owner', surface: 'local' });
  const named = id => doctor.checks.find(item => item.id === id);
  assert.equal(named('connection.address').status, 'info'); assert.match(named('connection.address').detail, /stays across restarts and updates of DevMate/); assert.match(named('connection.address').detail, /no event streams/);
  assert.match(named('security').fix, /devmate connect quick --new-address/);
  assert.match(named('security').detail, /quick tunnel has no sign-in/); assert.doesNotMatch(named('security').fix, /oauth/);
  // What the doctor prints is pasted into bug reports: it names the host and never the key.
  assert.ok(!JSON.stringify(doctor).includes(keyPath.split('/')[2]));
});

test('the key in a quick tunnel\'s address is made once and kept by the instance, until the owner asks for a new address', async t => {
  // It was new with every start, so the address changed with every restart even where the tunnel could have stayed.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-quick-key-'));
  const instanceRoot = path.join(temp, 'instance'); fs.mkdirSync(instanceRoot);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(instanceRoot, 'config.json'), JSON.stringify({ connection: { kind: 'cloudflare-quick', executable: process.execPath } }));
  const paths = [], stops = [];
  for (const round of [1, 2, 3]) {
    if (round === 3) forgetQuickTunnelKey(instanceRoot);
    const runtime = await startRuntime({ instanceRoot, port: 0, connectionFactory: ({ localMcpUrl }) => { paths.push(new URL(localMcpUrl).pathname);
      return { async start() {}, async stop(options) { stops.push(options); }, publicUrl: () => null, status() { return { kind: 'cloudflare-quick', phase: 'connecting', remoteMcpVerified: false }; } }; } });
    await runtime.stop();
  }
  assert.match(paths[0], /^\/mcp\/[A-Za-z0-9_-]{32}$/);
  assert.equal(paths[1], paths[0], 'the same key at the next start');
  assert.notEqual(paths[2], paths[1], 'a new key once the owner asked for one');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(instanceRoot, 'quick-tunnel.key')).mode & 0o777, 0o600);
  // A stop is a stop: the connection is told to end its connector. Only a stop to start again, said beside the
  // instance by whoever asks for it, keeps it.
  assert.deepEqual(stops, [{ keep: false }, { keep: false }, { keep: false }]);
  const again = await startRuntime({ instanceRoot, port: 0, connectionFactory: () => ({ async start() {}, async stop(options) { stops.push(options); }, publicUrl: () => null, status() { return { kind: 'cloudflare-quick', phase: 'connecting', remoteMcpVerified: false }; } }) });
  fs.writeFileSync(path.join(instanceRoot, 'restarting'), '');
  await again.stop();
  assert.deepEqual(stops.at(-1), { keep: true });
  assert.equal(fs.existsSync(path.join(instanceRoot, 'restarting')), false);
  const fake = () => ({ async start() {}, async stop(options) { stops.push(options); }, publicUrl: () => null, status() { return { kind: 'cloudflare-quick', phase: 'connecting', remoteMcpVerified: false }; } });
  // A runtime that fails ends it: until another runtime is started, which may be much later, a tunnel kept then would
  // forward the public address, key and all, to a port nobody holds.
  const failing = await startRuntime({ instanceRoot, port: 0, connectionFactory: fake });
  await failing.stop({}, { crashed: true });
  assert.deepEqual(stops.at(-1), { keep: false });
  // A word left from before this runtime started is no word for its stop, nor is one too old to be this stop's.
  fs.writeFileSync(path.join(instanceRoot, 'restarting'), '');
  const later = await startRuntime({ instanceRoot, port: 0, connectionFactory: fake });
  assert.equal(fs.existsSync(path.join(instanceRoot, 'restarting')), false, 'taken away when this runtime started');
  fs.writeFileSync(path.join(instanceRoot, 'restarting'), ''); const old = new Date(Date.now() - 180000); fs.utimesSync(path.join(instanceRoot, 'restarting'), old, old);
  await later.stop();
  assert.deepEqual(stops.at(-1), { keep: false });
});

test('a runtime comes in by the port a kept quick tunnel forwards to, and ends a kept tunnel that belongs to another connection', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-quick-port-'));
  const instanceRoot = path.join(temp, 'instance'); fs.mkdirSync(instanceRoot);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const free = () => new Promise(resolve => { const server = http.createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
  const fake = kind => () => ({ async start() {}, async stop() {}, publicUrl: () => null, status() { return { kind, phase: 'connecting', remoteMcpVerified: false }; } });
  // The tunnel forwards to the port the runtime before came in by: this one takes that port again, where it is free.
  const forwardsTo = await free();
  fs.writeFileSync(path.join(instanceRoot, 'config.json'), JSON.stringify({ connection: { kind: 'cloudflare-quick', executable: process.execPath } }));
  fs.writeFileSync(path.join(instanceRoot, 'quick-tunnel.json'), JSON.stringify({ kind: 'cloudflare-quick', forwardsTo, pid: 1, identity: 'nobody|0' }));
  const quick = await startRuntime({ instanceRoot, port: 0, connectionFactory: fake('cloudflare-quick') });
  try { assert.equal(quick.ingressPort, forwardsTo); } finally { await quick.stop(); }
  // Another connection now: a quick tunnel left running for this instance is ended before it starts.
  const { spawn } = await import('node:child_process');
  const left = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { left.kill('SIGKILL'); } catch {} });
  await new Promise((resolve, reject) => { left.once('spawn', resolve); left.once('error', reject); });
  const { ownedProcess } = await import('../runtime/platform/owned-process.mjs');
  await ownedProcess(path.join(instanceRoot, 'quick-tunnel.json')).remember(left.pid, { kind: 'cloudflare-quick', forwardsTo });
  const ended = new Promise(resolve => left.once('exit', () => resolve(true)));
  fs.writeFileSync(path.join(instanceRoot, 'config.json'), JSON.stringify({ connection: { kind: 'local' } }));
  const local = await startRuntime({ instanceRoot, port: 0, connectionFactory: fake('local') });
  try {
    let timer;
    assert.equal(await Promise.race([ended, new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]).finally(() => clearTimeout(timer)), true, 'the kept tunnel was ended');
    assert.equal(fs.existsSync(path.join(instanceRoot, 'quick-tunnel.json')), false);
  } finally { await local.stop(); }
});

test('through a quick tunnel every answer is one JSON body, also for a call that reports progress while it runs', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-quick-json-'));
  const instanceRoot = path.join(temp, 'instance'), projectRoot = path.join(temp, 'project'); fs.mkdirSync(instanceRoot); fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(instanceRoot, 'config.json'), JSON.stringify({ connection: { kind: 'cloudflare-quick', executable: process.execPath } }));
  const host = 'json-fixture.trycloudflare.com';
  let address = null;
  const runtime = await startRuntime({ instanceRoot, port: 0, connectionFactory: ({ localMcpUrl }) => { address = 'https://' + host + new URL(localMcpUrl).pathname;
    return { async start() {}, async stop() {}, publicUrl: () => address, status() { return { kind: 'cloudflare-quick', phase: 'connected', publicUrl: address, remoteMcpVerified: false }; } }; } });
  t.after(async () => { await runtime.stop(); fs.rmSync(temp, { recursive: true, force: true }); });
  await runtime.service.call('project.create', { root: projectRoot }, { id: 'owner', surface: 'local' });
  // Cloudflare does not carry event streams through a quick tunnel, so none may be answered there.
  const listening = await request(runtime.ingressPort, new URL(address).pathname, { headers: { host, accept: 'text/event-stream' } });
  assert.equal(listening.status, 405); assert.match(listening.headers['content-type'], /^application\/json/);
  // A client that speaks the 2025 protocol (what a client does unless told otherwise), and one that negotiates the current one.
  for (const [mode, negotiation] of [['2025 protocol', {}], ['current protocol', { versionNegotiation: { mode: 'auto' } }]]) {
    const seen = [];
    // The client believes it talks to the tunnel; what it sends arrives at the ingress the way cloudflared delivers it.
    const fetchImpl = async (input, init = {}) => {
      const answer = await request(runtime.ingressPort, new URL(String(input)).pathname, { method: init.method || 'GET', headers: { ...Object.fromEntries(new Headers(init.headers)), host }, body: init.body });
      seen.push((init.method || 'GET') + ' ' + answer.status + ' ' + String(answer.headers['content-type'] || '-').split(';')[0]);
      return new Response(answer.text || null, { status: answer.status, headers: answer.headers['content-type'] ? { 'content-type': answer.headers['content-type'] } : {} });
    };
    const client = new Client({ name: 'quick-tunnel-test', version: '1' }, negotiation);
    await client.connect(new StreamableHTTPClientTransport(new URL(address), { fetch: fetchImpl }), { timeout: 20000 });
    assert.ok((await client.listTools({}, { timeout: 20000 })).tools.some(tool => tool.name === 'shell_run'));
    let progress = 0;
    // Longer than the five seconds after which a call says that it is still alive.
    const result = await client.callTool({ name: 'shell_run', arguments: { file: process.execPath, args: ['-e', 'setTimeout(() => console.log("slept through it"), 5600)'], waitMs: 20000 } },
      { timeout: 40000, onprogress: () => { progress++; } });
    await client.close();
    assert.match(result.content[0].text, /slept through it/, mode + ': the result arrives');
    assert.equal(progress, 0, mode + ': nothing is streamed');
    assert.ok(seen.length >= 3 && seen.every(entry => !entry.includes('event-stream')), mode + ': ' + seen.join(', '));
    assert.ok(seen.some(entry => entry === 'POST 200 application/json'), mode + ': ' + seen.join(', '));
  }
});
test('a new address is not asked for before the world knows it, and a stale local answer is not called a broken route', async () => {
  const url = 'https://fresh-fixture.trycloudflare.com/mcp';
  let connected = 0;
  const failing = () => ({ async connect() { connected++; throw Object.assign(new Error('negotiation failed'), { code: 'ERA_NEGOTIATION_FAILED' }); }, async close() {} });
  const transportFactory = () => ({});
  // Public DNS does not know it yet: nothing is asked of this computer's resolver, so it cannot remember "no such name".
  const early = await verifyPublicMcp({ url, newAddress: true, knownPublicly: async () => false, clientFactory: failing, transportFactory,
    lookup: async () => { throw new Error('the local resolver must not be asked'); } });
  assert.deepEqual([early.verified, early.reachable, early.pending], [false, false, 'dns']); assert.equal(connected, 0);
  // Public DNS knows it, this computer still remembers its earlier answer: said as it is.
  const stale = await verifyPublicMcp({ url, newAddress: true, knownPublicly: async () => true, clientFactory: failing, transportFactory,
    lookup: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); } });
  assert.deepEqual([stale.verified, stale.reachable, stale.pending], [false, false, 'local-dns']); assert.match(stale.reason, /clients in the cloud can already connect/);
  // It resolves here and the round trip still fails: that is a route that does not work.
  const broken = await verifyPublicMcp({ url, newAddress: true, knownPublicly: async () => true, clientFactory: failing, transportFactory, lookup: async () => ({ address: '203.0.113.9', family: 4 }) });
  assert.deepEqual([broken.verified, broken.reachable, broken.pending], [false, false, undefined]); assert.equal(broken.reason, 'ERA_NEGOTIATION_FAILED');
  // An address that has always been there is checked as before, whatever public DNS says about it.
  const fixed = await verifyPublicMcp({ url: 'https://devmate.example.com/mcp', knownPublicly: async () => { throw new Error('not asked first'); }, clientFactory: failing, transportFactory,
    lookup: async () => ({ address: '203.0.113.9', family: 4 }) });
  assert.equal(fixed.reason, 'ERA_NEGOTIATION_FAILED');
});