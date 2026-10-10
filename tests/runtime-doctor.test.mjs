import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DevMateService } from '../runtime/service.mjs';
import { Store } from '../runtime/store.mjs';
import { createSecretStore } from '../runtime/secrets.mjs';
import { normalizeConfig } from '../runtime/config.mjs';
import { main as cli } from '../runtime/cli.mjs';

const require = createRequire(import.meta.url);
const { createVscodeRuntimeEntry } = require('../vscode-host/runtime-entry.cjs');
const owner = Object.freeze({ id: 'owner', role: 'owner', surface: 'local' });
// The owner of the instance closes first; only then can its directory be removed.
function temporary(t, prefix, close = () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const owned = { directory, close };
  t.after(async () => { await owned.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return owned;
}
async function service(t, config, extra = {}) {
  const owned = temporary(t, 'devmate-doctor-'), temp = owned.directory;
  const instance = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '', config, ...extra });
  owned.close = () => instance.close();
  await instance.ready;
  return { service: instance, temp };
}

test('connection credentials live in the instance, reach only the connection and are never returned', async t => {
  const { service: runtime, temp } = await service(t, {});
  const stored = await runtime.call('secret.set', { name: 'CLOUDFLARE_TUNNEL_TOKEN', value: '  token-value  ' }, owner);
  assert.deepEqual(stored, { name: 'CLOUDFLARE_TUNNEL_TOKEN', stored: true, restartRequired: true });
  assert.deepEqual(await runtime.call('secret.list', {}, owner), { names: ['CLOUDFLARE_TUNNEL_TOKEN'] });
  assert.equal(JSON.stringify(await runtime.call('settings.read', {}, owner)).includes('token-value'), false);
  const secrets = createSecretStore(path.join(temp, 'instance'));
  assert.equal(secrets.environment({ CLOUDFLARE_TUNNEL_TOKEN: 'from-environment', PATH: 'p' }).CLOUDFLARE_TUNNEL_TOKEN, 'token-value', 'a stored credential wins over the environment variable');
  assert.equal(process.env.CLOUDFLARE_TUNNEL_TOKEN === 'token-value', false, 'it is never placed in the runtime environment that project commands inherit');
  for (const [name, value] of [['bad name', 'x'], ['OK', 'two\nlines']]) await assert.rejects(runtime.call('secret.set', { name, value }, owner), { code: 'invalid_input' });
  // Credentials and the doctor are local-owner only: an MCP caller, even the owner, cannot reach them.
  for (const operation of ['secret.set', 'secret.list', 'secret.remove', 'runtime.doctor']) {
    await assert.rejects(runtime.call(operation, operation === 'secret.set' ? { name: 'A', value: 'b' } : operation === 'secret.remove' ? { name: 'A' } : {}, { id: 'owner', role: 'owner' }), { code: 'forbidden' });
  }
  assert.equal((await runtime.call('secret.remove', { name: 'CLOUDFLARE_TUNNEL_TOKEN' }, owner)).removed, true);
  assert.deepEqual(secrets.names(), []);
});

test('history, receipts and finished records are pruned by age while recent events and unfinished work stay', async t => {
  const owned = temporary(t, 'devmate-retention-'), store = new Store(path.join(owned.directory, 'instance'));
  owned.close = () => store.close();
  const finished = store.create('job', { kind: 'command', status: 'completed' }), running = store.create('job', { kind: 'command', status: 'running' });
  const answered = store.create('approval', { status: 'resolved' }), waiting = store.create('approval', { status: 'pending' });
  for (let index = 0; index < 26; index++) store.event('fixture.old', null, { index });
  store.saveOperation('owner:done', 'x', 'f', { value: 1 }); store.saveOperation('owner:pending', 'x', 'f', { pending: true });
  const past = new Date(Date.now() - 40 * 86400000).toISOString();
  store.db.prepare('UPDATE events SET created_at=?').run(past); store.db.prepare('UPDATE operations SET created_at=?').run(past);
  store.db.prepare("UPDATE entities SET data=json_set(data,'$.updatedAt',?)").run(past);
  const fresh = store.create('job', { kind: 'command', status: 'completed' });
  for (let index = 0; index < 4; index++) store.event('fixture.new', null, { index });
  assert.equal(store.revision, 35);
  assert.deepEqual(store.prune({ olderThanMs: 30 * 86400000, keepLatestEvents: 10 }), { events: 25, operations: 2, entities: 2 });
  assert.equal(store.events({ limit: 100 }).length, 10, 'the newest events survive regardless of age so clients can resume');
  assert.equal(store.operation('owner:done'), null);
  assert.equal(store.operation('owner:pending'), null, 'a receipt still pending after the whole retention period belongs to a call that never finished');
  for (const [kind, item] of [['job', running], ['approval', waiting], ['job', fresh]]) assert.equal(store.get(kind, item.id).id, item.id, 'unfinished and recent records stay');
  for (const [kind, item] of [['job', finished], ['approval', answered]]) assert.throws(() => store.get(kind, item.id), { code: 'not_found' });
  assert.deepEqual(store.prune({ olderThanMs: 30 * 86400000 }), { events: 0, operations: 0, entities: 0 });
  assert.throws(() => store.prune({}), TypeError);
  assert.equal(normalizeConfig({}).retentionDays, 30); assert.throws(() => normalizeConfig({ retentionDays: 0 }));
  // Recent activity is the newest of one scope, however busy other scopes are.
  const project = store.create('project', { name: 'p', root: owned.directory });
  for (const marker of ['first', 'second']) store.event('fixture.project', { id: 'x', projectId: project.id }, { marker });
  for (let index = 0; index < 150; index++) store.event('fixture.other', null, { index });
  assert.deepEqual(store.recentEvents({ projectId: project.id, limit: 100 }).map(event => event.marker), ['first', 'second']);
  assert.equal(store.recentEvents({ limit: 3 }).length, 3);
});

test('the doctor names what works, what is missing and the exact next step', async t => {
  const local = await service(t, {});
  const quiet = await local.service.call('runtime.doctor', {}, owner);
  const find = (report, id) => report.checks.find(item => item.id === id);
  assert.equal(find(quiet, 'node').status, 'ok'); assert.equal(find(quiet, 'shell').status, 'ok');
  assert.equal(find(quiet, 'connection').status, 'info'); assert.match(find(quiet, 'connection').fix, /openai-tunnel or cloudflare/);
  assert.equal(find(quiet, 'projects').status, 'warn'); assert.equal(find(quiet, 'security').status, 'ok');
  const exposed = await service(t, { connection: { kind: 'cloudflare', publicUrl: 'https://devmate.example.com/mcp', executable: process.execPath } },
    { verifier: async () => ({ verified: false, reachable: false, reason: 'ENOTFOUND' }) });
  exposed.service.connection = { status: () => ({ kind: 'cloudflare', phase: 'connecting', routeService: 'http://127.0.0.1:8789' }) };
  const report = await exposed.service.call('runtime.doctor', {}, owner);
  assert.equal(report.status, 'fail');
  assert.equal(find(report, 'connection.executable').status, 'ok');
  assert.equal(find(report, 'connection.credential').status, 'fail'); assert.match(find(report, 'connection.credential').fix, /devmate secret set CLOUDFLARE_TUNNEL_TOKEN/);
  assert.equal(find(report, 'connection.public').status, 'fail'); assert.match(find(report, 'connection.public').fix, /route the hostname to http:\/\/127\.0\.0\.1:8789/);
  assert.equal(find(report, 'security').status, 'warn'); assert.match(find(report, 'security').fix, /oauth, issuer https:\/\/devmate\.example\.com\).*devmate login-code/);
  await exposed.service.call('secret.set', { name: 'CLOUDFLARE_TUNNEL_TOKEN', value: 't' }, owner);
  exposed.service.verifier = async () => ({ verified: true, reachable: true, tools: 70 }); exposed.service.verification = null;
  exposed.service.connection = { status: () => ({ kind: 'cloudflare', phase: 'connected' }) };
  const healthy = await exposed.service.call('runtime.doctor', {}, owner);
  assert.equal(find(healthy, 'connection.credential').status, 'ok'); assert.equal(find(healthy, 'connection.public').status, 'ok');
  assert.equal(healthy.status, 'warn', 'a verified but unauthenticated public URL is still a warning');
  // The CLI prints the same report and fails the command only when something is broken.
  const lines = [];
  const code = await cli(['doctor'], { stdout: { write: text => lines.push(text) }, stderr: { write() {} }, clientFactory: () => ({ call: async () => report }) });
  assert.equal(code, 1); assert.match(lines.join(''), /\[FAIL\] connection\.credential: CLOUDFLARE_TUNNEL_TOKEN is missing\n\s+-> Store it with: devmate secret set CLOUDFLARE_TUNNEL_TOKEN/);
  assert.equal(await cli(['doctor'], { stdout: { write() {} }, stderr: { write() {} }, clientFactory: () => ({ call: async () => healthy }) }), 0);
});

test('the VS Code connection wizard stores the token privately, saves a signed-in Cloudflare route and offers the URL and sign-in code', async () => {
  const calls = [], copied = [], messages = [], confirmations = [];
  let running = true, rejectSettings = false, saved = { auth: { mode: 'none' }, connection: { kind: 'local' }, retentionDays: 30 };
  const answers = { picks: ['Cloudflare Tunnel', 'Require sign-in'], inputs: ['https://devmate.example.com/anything', 'C:\\cf\\cloudflared.exe', 'cf-token'] };
  const client = { start: async () => { running = true; }, stop: async () => { running = false; }, status: async () => ({ running, state: 'ready', record: { generation: 'g' } }),
    snapshot: async () => ({}), operations: async () => ({ items: [] }), workbenchUrl: async () => 'http://127.0.0.1:8788', dispose() {}, subscribe: () => ({ dispose() {} }),
    call: async (name, input) => {
      calls.push([name, input]);
      if (name === 'window.attach') return { windowId: input.windowId, roots: [], selectedProjectId: null };
      if (name === 'settings.read') return { saved };
      if (name === 'settings.replace' && rejectSettings) throw Object.assign(new Error('invalid_executable'), { code: 'invalid_executable' });
      if (name === 'settings.replace') saved = input.config;
      if (name === 'connection.status') return { kind: 'cloudflare', publicUrl: 'https://devmate.example.com/mcp' };
      if (name === 'auth.code.create') return { code: 'dml_one-time' };
      if (name === 'runtime.doctor') return { version: '4.0.0', status: 'ok', checks: [{ id: 'node', status: 'ok', detail: 'Node.js' }] };
      return {};
    } };
  const commands = new Map();
  const vscode = {
    TreeItem: class { constructor(label) { this.label = label; } }, TreeItemCollapsibleState: { None: 0 },
    EventEmitter: class { constructor() { this.event = () => {}; } fire() {} dispose() {} },
    workspace: { name: 'Empty', isTrusted: true, workspaceFolders: [], getConfiguration: () => ({ get: (_name, fallback) => fallback }) },
    window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }), registerTreeDataProvider: () => ({ dispose() {} }),
      showErrorMessage: async message => { messages.push('error: ' + message); },
      showWarningMessage: async (message, options, ...actions) => { confirmations.push({ message, ...options }); return actions[0]; },
      showInformationMessage: async (message, ...actions) => { messages.push(message); return actions[0]; },
      showQuickPick: async items => { const wanted = answers.picks.shift(); return items.find(item => item.label === wanted); },
      showInputBox: async () => answers.inputs.shift() },
    commands: { registerCommand: (id, handler) => { commands.set(id, handler); return { dispose() {} }; } },
    env: { openExternal: async () => true, clipboard: { writeText: async value => { copied.push(value); } } }, Uri: { parse: value => value }
  };
  const entry = createVscodeRuntimeEntry(vscode, { client });
  await entry.activate({ subscriptions: [] });
  // While sign-in is off there is no code to copy, and the command says where sign-in is switched on.
  await commands.get('devMate.runtime.loginCode')();
  assert.match(messages.at(-1), /Sign-in is off/); assert.deepEqual(copied, []);
  const config = await commands.get('devMate.runtime.configureConnection')();
  assert.deepEqual(config.connection, { kind: 'cloudflare', publicUrl: 'https://devmate.example.com/mcp', executable: 'C:\\cf\\cloudflared.exe', tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN' });
  assert.deepEqual(config.auth, { mode: 'oauth', issuer: 'https://devmate.example.com' }); assert.equal(config.retentionDays, 30, 'unrelated settings are preserved');
  const named = name => calls.filter(([operation]) => operation === name).map(([, input]) => input);
  assert.deepEqual(named('secret.set'), [{ name: 'CLOUDFLARE_TUNNEL_TOKEN', value: 'cf-token' }]);
  assert.deepEqual(named('settings.replace'), [{ config }]); assert.equal(JSON.stringify(config).includes('cf-token'), false);
  const order = calls.map(([operation]) => operation).filter(operation => ['settings.replace', 'secret.set'].includes(operation));
  assert.deepEqual(order, ['settings.replace', 'secret.set'], 'settings are validated before a credential is stored');
  // Restarting the runtime every window shares is a decision, asked in a modal dialog that names the route to configure.
  assert.equal(confirmations[0].modal, true); assert.match(confirmations[0].message, /Restart the shared DevMate runtime/);
  assert.match(confirmations[0].detail, /route the hostname to http:\/\/127\.0\.0\.1:8789/); assert.equal(named('runtime.doctor').length, 1, 'a restart is followed by a check');
  assert.equal(await commands.get('devMate.runtime.copyMcpUrl')(), 'https://devmate.example.com/mcp');
  await commands.get('devMate.runtime.loginCode')();
  assert.deepEqual(copied, ['https://devmate.example.com/mcp', 'dml_one-time']);
  // A configuration the runtime rejects leaves no credential behind.
  rejectSettings = true; calls.length = 0;
  answers.picks = ['OpenAI Secure MCP Tunnel']; answers.inputs = ['tunnel_abc', 'relative\\tunnel-client.exe', 'runtime-key'];
  assert.equal(await commands.get('devMate.runtime.configureConnection')(), undefined);
  assert.deepEqual(named('secret.set'), []); assert.match(messages.at(-1), /^error: invalid_executable/);
  rejectSettings = false;
  answers.picks = ['Local only'];
  const local = await commands.get('devMate.runtime.configureConnection')();
  assert.deepEqual(local.connection, { kind: 'local' }); assert.deepEqual(local.auth, { mode: 'none' });
  await entry.deactivate();
});

test('restorable versions are bounded by age and by total size, least recently used first', async t => {
  const { __test } = await import('../runtime/service.mjs');
  const owned = temporary(t, 'devmate-history-cap-'), directory = path.join(owned.directory, 'history');
  fs.mkdirSync(directory);
  const version = (name, bytes, daysAgo) => { const file = path.join(directory, name); fs.writeFileSync(file, Buffer.alloc(bytes)); const at = new Date(Date.now() - daysAgo * 86400000); fs.utimesSync(file, at, at); };
  version('expired', 10, 45); version('oldest', 100, 20); version('middle', 100, 10); version('newest', 100, 1);
  __test.pruneHistory(directory, 30 * 86400000, 250);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['middle', 'newest'], 'past the size bound the version used longest ago goes first');
  __test.pruneHistory(directory, 30 * 86400000);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['middle', 'newest'], 'within both bounds nothing is removed');
  assert.doesNotThrow(() => __test.pruneHistory(path.join(owned.directory, 'missing'), 1000));
});

test('the doctor warns when the instance lives where other accounts of this computer can read it', { skip: process.platform !== 'win32' && 'file modes protect the instance elsewhere' }, async t => {
  const outside = await service(t, {});
  const check = (await outside.service.call('runtime.doctor', {}, owner)).checks.find(item => item.id === 'instance');
  if (path.relative(os.homedir(), outside.temp).startsWith('..') || path.parse(outside.temp).root !== path.parse(os.homedir()).root) {
    assert.equal(check.status, 'warn'); assert.match(check.fix, /owner token and credentials/);
  } else assert.equal(check, undefined);
});
