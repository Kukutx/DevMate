import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { Store, STATE_MINOR } from '../runtime/store.mjs';
import { createSecretStore } from '../runtime/secrets.mjs';
import { createJobRunner } from '../runtime/jobs.mjs';
import { createProcessManager } from '../runtime/processes.mjs';
import { serveStdioBridge } from '../runtime/stdio-bridge.mjs';
import { startRuntime } from '../runtime/main.mjs';
import { readRuntimeRecord } from '../runtime/client.mjs';
import { __test as lock } from '../runtime/instance-lock.mjs';
import { VERSION } from '../runtime/version.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const localConnection = () => ({ async start() {}, async stop() {}, status() { return { kind: 'local', status: 'ready' }; } });
function scratch(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-' + name + '-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}
async function until(check, label, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error('Timed out: ' + label); await delay(20); }
}

test('stored state says which DevMate wrote it, and a DevMate that would misread it leaves it alone and says why', t => {
  const directory = scratch(t, 'format');
  const first = new Store(directory);
  assert.deepEqual(first.setting('state.format'), { minor: STATE_MINOR, writtenBy: VERSION });
  first.setting('state.format', { minor: STATE_MINOR + 1, writtenBy: '4.99.0' });
  first.close();
  assert.throws(() => new Store(directory), error => error.code === 'state_version' && /last used by DevMate 4\.99\.0/.test(error.message) && /Update this DevMate/.test(error.message));
  // Nothing was touched by the refusal, and the file is not held: the newer DevMate still finds its state.
  const raw = new DatabaseSync(path.join(directory, 'state.sqlite'));
  assert.equal(JSON.parse(raw.prepare("SELECT value FROM settings WHERE key='state.format'").get().value).writtenBy, '4.99.0');
  raw.exec('PRAGMA user_version=5'); raw.close();
  assert.throws(() => new Store(directory), error => error.code === 'state_version' && /newer DevMate \(state version 5\)/.test(error.message));
  // A file that is not a database is named, with the way out, and can be moved away at once.
  const damaged = scratch(t, 'damaged');
  fs.writeFileSync(path.join(damaged, 'state.sqlite'), 'this is not a database');
  assert.throws(() => new Store(damaged), error => error.code === 'state_unreadable' && error.message.includes(path.join(damaged, 'state.sqlite')) && /Move it away/.test(error.message));
  fs.renameSync(path.join(damaged, 'state.sqlite'), path.join(damaged, 'state.sqlite.broken'));
  new Store(damaged).close();
});

test('state files cut short by a crash do not lock the owner out: credentials, the runtime record, the instance identity', async t => {
  const directory = scratch(t, 'cut-short');
  const secrets = createSecretStore(directory), file = path.join(directory, 'secrets.json');
  secrets.set('TUNNEL_TOKEN', 'first-value');
  fs.writeFileSync(file, '{"TUNNEL_TOKEN": "first-va');
  assert.throws(() => secrets.names(), error => error.code === 'invalid_secrets' && error.message.includes(file) && /devmate secret set/.test(error.message));
  // Storing a credential is how the file is repaired.
  assert.deepEqual(secrets.set('TUNNEL_TOKEN', 'second-value'), { name: 'TUNNEL_TOKEN', stored: true, restartRequired: true, replacedDamagedFile: true });
  assert.deepEqual(secrets.names(), ['TUNNEL_TOKEN']);
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')), [], 'no temporary file is left behind');
  // A half-written record is no record; whether a runtime lives is the lock's answer.
  fs.writeFileSync(path.join(directory, 'runtime.json'), '{"pid": 12');
  assert.equal(readRuntimeRecord(directory), null);
  // An identity file created and never filled (full disk, killed process) is replaced instead of blocking every start.
  const instance = path.join(directory, 'instance');
  fs.mkdirSync(instance);
  for (const content of ['', 'c0ffee00-12']) {
    fs.writeFileSync(path.join(instance, 'instance-id'), content);
    const runtime = await startRuntime({ instanceRoot: instance, port: 0, connectionFactory: localConnection });
    assert.match(fs.readFileSync(path.join(instance, 'instance-id'), 'utf8'), /^[a-f0-9-]{36}$/);
    assert.equal(runtime.health.instanceId, fs.readFileSync(path.join(instance, 'instance-id'), 'utf8'));
    await runtime.stop();
  }
  // Leftover command logs that another program holds or that cannot be removed never decide a start.
  fs.mkdirSync(path.join(instance, 'processes', 'left-over-directory'), { recursive: true });
  const again = await startRuntime({ instanceRoot: instance, port: 0, connectionFactory: localConnection });
  await again.stop();
});

test('two starters that both find a dead socket do not both become owner, and an abandoned claim is broken', async t => {
  const directory = scratch(t, 'claim'), endpoint = path.join(directory, 'runtime.sock');
  fs.writeFileSync(endpoint, 'stale');
  let owner = null, listening = 0;
  const probe = async () => { await delay(15); return owner ? { alive: true, pid: owner } : { alive: false }; };
  const starter = pid => lock.replaceStale(endpoint, async () => { await delay(15); listening++; owner = pid; fs.writeFileSync(endpoint, 'socket of ' + pid); return pid; }, probe, { waitMs: 5 })
    .then(value => ({ value }), error => ({ error }));
  const results = await Promise.all([starter(101), starter(202), starter(303)]);
  assert.equal(listening, 1, 'exactly one starter listened');
  assert.equal(results.filter(item => item.value).length, 1);
  for (const item of results.filter(item => item.error)) { assert.equal(item.error.code, 'instance_running'); assert.equal(item.error.owner.pid, owner); }
  assert.equal(fs.readFileSync(endpoint, 'utf8'), 'socket of ' + owner, 'the winner\'s socket was not removed by a loser');
  assert.equal(fs.existsSync(endpoint + '.claim'), false);
  // A starter that died while holding the claim does not block the instance for good.
  owner = null; listening = 0;
  fs.writeFileSync(endpoint + '.claim', '');
  const old = new Date(Date.now() - 60000); fs.utimesSync(endpoint + '.claim', old, old);
  assert.equal((await starter(404)).value, 404);
  // A fresh claim that never goes away ends in a refusal, not in a hang.
  owner = null;
  fs.writeFileSync(endpoint + '.claim', '');
  const refused = await lock.replaceStale(endpoint, async () => 1, probe, { waitMs: 2, attempts: 5 }).then(() => null, error => error);
  assert.equal(refused.code, 'instance_running');
});

test('a job whose stop could not be confirmed frees its project once the process is gone, and a failed state write is not fatal', async t => {
  // Closed before the directory is removed, in one hook: the database and the command logs live in it.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-jobs-'));
  const store = new Store(directory);
  const root = path.join(directory, 'project'); fs.mkdirSync(root);
  const project = store.create('project', { name: 'project', root, access: 'write', protectSecrets: true, status: 'ready' });
  // Termination that reports failure every time, as taskkill does under load or against a protected child.
  let confirmable = false;
  const processes = createProcessManager({ instanceRoot: directory, store, terminateImpl: async child => { if (confirmable) child.kill('SIGKILL'); return { exitConfirmed: false }; } });
  let failWrites = 0;
  const update = store.update.bind(store);
  store.update = (kind, id, patch, ...rest) => { if (kind === 'job' && patch?.status === 'running' && failWrites-- > 0) throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR' }); return update(kind, id, patch, ...rest); };
  const runner = createJobRunner({ store, execute: (job, { signal }) => processes.complete(project, job.input.args, { signal }) });
  const uncaught = [];
  const onUncaught = error => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  t.after(async () => {
    process.off('uncaughtException', onUncaught); confirmable = true;
    await runner.close().catch(() => {}); await processes.close().catch(() => {}); store.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const sleeper = { file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, quick = { file: process.execPath, args: ['-e', 'console.log("done")'] };
  const first = runner.start({ projectId: project.id, kind: 'command', input: { args: sleeper } });
  await until(() => store.get('job', first.id).status === 'running', 'the first job runs');
  const cancelled = await runner.cancel(first.id);
  assert.equal(cancelled.status, 'unknown'); assert.equal(cancelled.exitConfirmed, false);
  assert.equal(JSON.stringify(cancelled).includes('retryTermination'), false, 'the way to ask again is not stored with the job');
  const second = runner.start({ projectId: project.id, kind: 'command', input: { args: quick } });
  await delay(200);
  assert.equal(store.get('job', second.id).status, 'queued', 'the project stays held while the first process may still run');
  // The process is gone now (here: the next attempt ends it). Asking again confirms it and releases the project.
  confirmable = true;
  await until(async () => (await runner.cancel(first.id)).exitConfirmed === true, 'termination confirmed on a later attempt');
  await until(() => store.get('job', second.id).status === 'completed', 'the queued job of the same project runs');
  // One failed write when a job is dispatched: the job stays queued and runs on the next attempt.
  failWrites = 1;
  const third = runner.start({ projectId: project.id, kind: 'command', input: { args: quick } });
  await delay(100);
  assert.equal(store.get('job', third.id).status, 'queued');
  await until(() => store.get('job', third.id).status === 'completed', 'the job runs after the write succeeds', 15000);
  assert.deepEqual(uncaught, []);
  await runner.close();
});

// A stdio client on one side, an HTTP stand-in for the runtime on the other.
async function bridged(t, connect) {
  const stdin = new PassThrough(), stdout = new PassThrough(), notes = [], replies = [];
  let buffered = '';
  stdout.on('data', chunk => { buffered += chunk; let at; while ((at = buffered.indexOf('\n')) >= 0) { const line = buffered.slice(0, at); buffered = buffered.slice(at + 1); if (line.trim()) replies.push(JSON.parse(line)); } });
  const bridge = await serveStdioBridge({ connect, stdin, stdout, log: line => notes.push(line) });
  t.after(() => bridge.close());
  const ask = async (id, method = 'tools/call') => {
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { name: 'shell_run', arguments: {} } }) + '\n');
    return until(() => replies.find(reply => reply.id === id), 'an answer to request ' + id);
  };
  return { ask, notes };
}
function standIn(t, handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    t.after(() => new Promise(done => { server.closeAllConnections?.(); server.close(done); }));
    server.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port + '/mcp' }));
  });
}

test('devmate mcp never sends a call twice that may have started, and does look again for a runtime it could not reach', async t => {
  // 1. The runtime dies while the call is in progress: the request arrived, so it is not replayed.
  let arrived = 0;
  const dying = await standIn(t, (req, res) => { req.resume(); req.on('end', () => { arrived++; res.socket.destroy(); }); });
  const first = await bridged(t, async () => dying.url);
  const lost = await first.ask(1);
  assert.equal(arrived, 1, 'the call reached the runtime exactly once');
  assert.match(lost.error.message, /may or may not have taken effect/);
  // 2. Nobody listens at the address first resolved (the runtime was restarted on another port): nothing was delivered, so the call is sent to the new address.
  const closed = net.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const deadUrl = 'http://127.0.0.1:' + closed.address().port + '/mcp';
  await new Promise(resolve => closed.close(resolve));
  let served = 0;
  const alive = await standIn(t, (req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { served++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: { content: [{ type: 'text', text: 'ran once' }] } })); });
  });
  const addresses = [deadUrl, alive.url];
  const second = await bridged(t, async () => addresses.shift() || alive.url);
  const answered = await second.ask(2);
  assert.equal(answered.result.content[0].text, 'ran once'); assert.equal(served, 1);
  // 3. A runtime that turns the call away while stopping has not started it either.
  let refusals = 0;
  const stopping = await standIn(t, (req, res) => { req.resume(); req.on('end', () => { refusals++; res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":{"code":"runtime_stopping"}}'); }); });
  const routes = [stopping.url, alive.url];
  const third = await bridged(t, async () => routes.shift() || alive.url);
  assert.equal((await third.ask(3)).result.content[0].text, 'ran once');
  assert.equal(refusals, 1); assert.equal(served, 2);
});
