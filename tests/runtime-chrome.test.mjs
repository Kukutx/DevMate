import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BROWSER_CAPABILITIES, EXTENSION_ORIGIN, NATIVE_HOST, createBrowserLink } from '../runtime/chrome.mjs';
import { frame, frames } from '../runtime/chrome-host.mjs';
import { createChromeRegistration } from '../runtime/platform/chrome-registration.mjs';
import { READ_ONLY, createCapabilities } from '../chrome-extension/capabilities.js';
import { startRuntime } from '../runtime/main.mjs';
import { main as cli } from '../runtime/cli.mjs';

const owner = { id: 'owner', surface: 'local' }, connected = { id: 'owner' };
const output = () => { const sink = { text: '', write(value) { sink.text += value; } }; return sink; };
const until = async (condition, what, ms = 15000) => { const end = Date.now() + ms; while (!(await condition())) { if (Date.now() > end) throw new Error('timed out waiting for ' + what); await new Promise(resolve => setTimeout(resolve, 20)); } };

test('the runtime offers exactly what the extension can do, each as a read or as a change the way the extension says', () => {
  const extension = Object.keys(createCapabilities({}, {})).sort();
  assert.deepEqual(BROWSER_CAPABILITIES.map(item => item.method).sort(), extension);
  assert.deepEqual(BROWSER_CAPABILITIES.filter(item => item.readOnly).map(item => item.method).sort(), [...READ_ONLY].sort());
  assert.ok(BROWSER_CAPABILITIES.every(item => item.name === 'chrome.' + item.method && item.description.length > 8 && item.description.length < 400));
  // The extension is the one of the fixed key in its manifest, and the host is registered for that one alone.
  const manifest = JSON.parse(fs.readFileSync(new URL('../chrome-extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(EXTENSION_ORIGIN, 'chrome-extension://cbogglgkdnlbglhiljblbnhngmbeiomm/'); assert.ok(manifest.permissions.includes('nativeMessaging')); assert.equal(NATIVE_HOST, 'io.github.kukutx.devmate');
});

test('a browser link hands a call to the browser that asks for work and brings its answer back, and says plainly when no browser is there', async () => {
  let clock = 1000;
  const link = createBrowserLink({ now: () => clock, callTimeoutMs: 200 });
  await assert.rejects(link.call({ capability: 'chrome.tabs.list' }), { code: 'browser_unavailable', notStarted: true, message: /No browser is connected to DevMate\. Open Chrome or Edge with the DevMate extension.*devmate chrome install/ });
  await assert.rejects(link.call({ capability: 'chrome.nothing' }), { code: 'unknown_capability' });
  assert.deepEqual(link.status(), { connected: false });
  const { linkId } = link.attach({ browser: 'Google Chrome', extension: '4.0.5', methods: ['tabs.list', 'tabs.close', 'page.screenshot'] });
  assert.equal(link.status().connected, true);
  // What only reads may be asked for as a read; a change may not, and wrong input never reaches the browser.
  await assert.rejects(link.call({ capability: 'chrome.tabs.close', input: { tabIds: [1] } }, { readOnly: true }), { code: 'forbidden', notStarted: true });
  await assert.rejects(link.call({ capability: 'chrome.tabs.close', input: { tabIds: 'all' } }), { code: 'invalid_input', notStarted: true });
  await assert.rejects(link.call({ capability: 'chrome.bookmarks.tree' }), { code: 'not_supported', message: /has no bookmarks\.tree\. Update the extension/ });
  const asked = link.call({ capability: 'chrome.tabs.list', input: { query: 'docs' } }, { readOnly: true });
  const { calls } = await link.next({ linkId, waitMs: 1000 });
  assert.deepEqual(calls.map(call => [call.method, call.params]), [['tabs.list', { query: 'docs' }]]);
  assert.deepEqual(link.result({ linkId, id: calls[0].id, ok: true, result: { items: [{ id: 7, title: 'Docs' }] } }), { accepted: true });
  assert.deepEqual(await asked, { items: [{ id: 7, title: 'Docs' }] });
  // The browser's own refusal keeps its code; a picture is handed on as a picture.
  const refused = link.call({ capability: 'chrome.tabs.close', input: { tabIds: [99] } }), second = await link.next({ linkId, waitMs: 1000 });
  link.result({ linkId, id: second.calls[0].id, ok: false, error: { code: 'not_found', message: 'One of these tabs does not exist: 99.' } });
  await assert.rejects(refused, { code: 'not_found', message: /99/ });
  const picture = link.call({ capability: 'chrome.page.screenshot' }, { readOnly: true }), third = await link.next({ linkId, waitMs: 1000 });
  link.result({ linkId, id: third.calls[0].id, ok: true, result: { tabId: 7, mimeType: 'image/png', base64: 'aGk=' } });
  assert.deepEqual((await picture).content[0], { type: 'image', data: 'aGk=', mimeType: 'image/png' });
  // A browser that does not answer is said to be that; one that stopped asking for work is no longer there.
  await assert.rejects(link.call({ capability: 'chrome.tabs.list' }), { code: 'browser_timeout', notStarted: true });
  assert.deepEqual(await link.next({ linkId, waitMs: 10 }), { calls: [] });
  clock += 60000;
  assert.deepEqual(link.status(), { connected: false });
  await assert.rejects(async () => link.next({ linkId }), { code: 'not_found' });
});

test('devmate chrome install tells Chrome and Edge which program the DevMate extension may start, for this account only, and uninstall takes it away', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-chrome-')), root = path.join(temp, 'my instance 100%'), program = path.join(temp, 'cli.mjs'), home = path.join(temp, 'home');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.writeFileSync(program, '');
  // Windows: a registry key of the owner's own account for each browser, each naming the same small file. The registry
  // is the one every program sees (reached through Windows' management service), stood in for here.
  const keys = new Map(), asked = [];
  const registry = {
    read: async names => { asked.push(['read', names.length]); return names.map(name => keys.get(name) ?? null); },
    write: async (names, value) => { asked.push(['write', names.length]); for (const name of names) keys.set(name, value); return names.map(() => 0); },
    remove: async names => { asked.push(['remove', names.length]); return names.map(name => keys.delete(name) ? 0 : 2); }
  };
  const run = async () => { throw new Error('nothing is started in this test'); };
  const windows = createChromeRegistration({ instanceRoot: root, cli: program, node: process.execPath, platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, registry });
  assert.deepEqual(await windows.status({ ask: false }), { registered: false, supported: true, browsers: [], host: NATIVE_HOST, extension: EXTENSION_ORIGIN }); assert.equal(asked.length, 0, 'a quick look asks nothing where nothing was written');
  const installed = await windows.install();
  assert.deepEqual([installed.registered, installed.browsers, installed.stale], [true, ['Chrome', 'Edge', 'Chromium'], undefined]);
  assert.deepEqual([...keys.keys()], ['Software\\Google\\Chrome\\NativeMessagingHosts\\' + NATIVE_HOST, 'Software\\Microsoft\\Edge\\NativeMessagingHosts\\' + NATIVE_HOST, 'Software\\Chromium\\NativeMessagingHosts\\' + NATIVE_HOST]);
  assert.ok([...keys.values()].every(value => value === windows.files.manifest)); assert.deepEqual(asked, [['write', 3], ['read', 3]]);
  // A key that names another instance's file is not this registration.
  keys.set('Software\\Chromium\\NativeMessagingHosts\\' + NATIVE_HOST, 'C:\\elsewhere\\' + NATIVE_HOST + '.json');
  assert.deepEqual((await windows.status()).browsers, ['Chrome', 'Edge']);
  // What Windows is asked: one script for all three keys, through its management service, in a form no quoting can break.
  const scripts = [];
  const real = createChromeRegistration({ instanceRoot: root, cli: program, node: process.execPath, platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
    run: async (tool, args) => { scripts.push([tool, args.slice(0, -1), Buffer.from(args.at(-1), 'base64').toString('utf16le')]);
      return { code: 0, stdout: Buffer.from(JSON.stringify([windows.files.manifest, null, windows.files.manifest])).toString('base64') + '\r\n', stderr: '' }; } });
  assert.deepEqual((await real.status()).browsers, ['Chrome', 'Chromium']);
  assert.deepEqual(scripts[0].slice(0, 2), ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand']]);
  assert.match(scripts[0][2], /Invoke-CimMethod -Namespace root\\default -ClassName StdRegProv/); assert.match(scripts[0][2], /hDefKey = \[uint32\]2147483649/); assert.match(scripts[0][2], /GetStringValue/);
  assert.ok(scripts[0][2].includes("'Software\\Google\\Chrome\\NativeMessagingHosts\\" + NATIVE_HOST + "'"));
  await assert.rejects(createChromeRegistration({ instanceRoot: root, cli: program, platform: 'win32', env: {}, run: async () => ({ code: 1, stdout: '', stderr: 'denied' }) }).status(), { code: 'registration_failed' });
  // The file names the program and the one extension that may start it; the program is this Node with this DevMate.
  assert.deepEqual(JSON.parse(fs.readFileSync(windows.files.manifest, 'utf8')), { name: NATIVE_HOST, description: 'DevMate: the runtime on this computer, for the DevMate browser extension.', path: windows.files.shim, type: 'stdio', allowed_origins: [EXTENSION_ORIGIN] });
  assert.equal(fs.readFileSync(windows.files.shim, 'utf8'), '@echo off\r\n"' + process.execPath + '" "' + program + '" chrome-host --instance "' + path.resolve(root).replace(/%/g, '%%') + '" %*\r\n');
  // The copy of DevMate it names is gone: said, with nothing else changed.
  fs.rmSync(program); assert.equal((await windows.status()).stale, true); fs.writeFileSync(program, '');
  assert.deepEqual([(await windows.uninstall()).registered, [...keys.values()], fs.existsSync(path.dirname(windows.files.manifest))], [false, ['C:\\elsewhere\\' + NATIVE_HOST + '.json'], false], 'a key that names another instance\'s file is left where it is');

  // Elsewhere the same file lies in the folder of each browser that is installed, and the program is a shell script.
  fs.mkdirSync(path.join(home, '.config', 'microsoft-edge'), { recursive: true });
  const linux = createChromeRegistration({ instanceRoot: root, cli: program, node: '/opt/node 24/bin/node', platform: 'linux', home, run });
  const there = await linux.install();
  assert.deepEqual(there.browsers, ['Chrome', 'Edge']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts', NATIVE_HOST + '.json'), 'utf8')).path, linux.files.shim);
  assert.equal(fs.readFileSync(linux.files.shim, 'utf8'), '#!/bin/sh\nexec \'/opt/node 24/bin/node\' \'' + program + '\' \'chrome-host\' \'--instance\' \'' + path.resolve(root) + '\' "$@"\n');
  assert.equal(fs.existsSync(path.join(home, '.config', 'chromium')), false, 'a browser that is not installed gets no folder');
  assert.equal((await linux.uninstall()).registered, false); assert.equal(fs.existsSync(path.join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts', NATIVE_HOST + '.json')), false);
  assert.deepEqual(await createChromeRegistration({ instanceRoot: root, cli: program, platform: 'freebsd', run }).status(), { registered: false, supported: false });

  // The command: the owner's to run, and it says what is left to do in the browser.
  let state = { registered: false, supported: true, browsers: [] };
  const fake = { status: async () => state, install: async () => (state = { registered: true, supported: true, browsers: ['Chrome', 'Edge'] }), uninstall: async () => (state = { registered: false, supported: true, browsers: [] }) };
  const command = async (args, env = {}) => { const stdout = output(), stderr = output(); const code = await cli([...args, '--instance', root], { stdout, stderr, env, browserHost: async () => fake }); return { code, out: stdout.text, err: stderr.text }; };
  assert.match(JSON.parse((await command(['chrome'])).out).next[0], /devmate chrome install/);
  const done = JSON.parse((await command(['chrome', 'install'])).out);
  assert.equal(done.registered, true); assert.match(done.next[0], /chrome:\/\/extensions .* "Load unpacked" and pick .*chrome-extension/);
  for (const action of ['install', 'uninstall']) { const refused = await command(['chrome', action], { DEVMATE_CLIENT_COMMAND: '1' }); assert.notEqual(refused.code, 0); assert.match(refused.err, /run by the owner in their own terminal/); }
  assert.equal(JSON.parse((await command(['chrome', 'uninstall'])).out).registered, false);
});

test('the browser host is the link, end to end: started as a browser starts it, it serves the extension as an entry and carries the runtime\'s calls to the browser', { timeout: 120000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-chrome-host-')), instanceRoot = path.join(temp, 'instance');
  let runtime, host;
  t.after(async () => { host?.kill(); await runtime?.stop(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const program = fileURLToPath(new URL('../runtime/cli.mjs', import.meta.url));
  // Anyone but the DevMate extension is not served: the program ends at once and says nothing a browser would read.
  const stranger = spawn(process.execPath, [program, 'chrome-host', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/', '--instance', instanceRoot], { stdio: ['pipe', 'pipe', 'pipe'] });
  let strangerOut = Buffer.alloc(0); stranger.stdout.on('data', chunk => { strangerOut = Buffer.concat([strangerOut, chunk]); });
  assert.equal(await new Promise(resolve => stranger.once('exit', resolve)), 2); assert.equal(strangerOut.length, 0);

  // The extension's side of the conversation, as the browser would carry it: frames on the program's standard streams.
  const received = [], waiting = [];
  const start = () => {
    host = spawn(process.execPath, [program, 'chrome-host', EXTENSION_ORIGIN, '--parent-window=0', '--instance', instanceRoot], { stdio: ['pipe', 'pipe', 'pipe'] });
    host.stdout.on('data', frames(message => { received.push(message); for (const waiter of waiting.splice(0)) waiter(); }));
    host.stderr.on('data', () => {});
  };
  const say = message => host.stdin.write(frame(message));
  const hear = async (match, what) => { await until(() => received.some(match), what); return received.splice(received.findIndex(match), 1)[0]; };
  let nextId = 1;
  const ask = async (action, input) => { const id = nextId++; say({ type: 'request', id, action, ...(input ? { input } : {}) }); return hear(message => message.type === 'response' && message.id === id, 'the answer to ' + action); };
  start();
  say({ type: 'hello', protocol: 1, extension: '4.0.5', browser: 'Google Chrome', methods: BROWSER_CAPABILITIES.map(item => item.method) });
  // No runtime runs, and the host does not start one by itself: that is the extension's switch.
  const ready = await hear(message => message.type === 'ready', 'ready');
  assert.deepEqual([ready.protocol, ready.runtime.running], [1, false]);
  assert.deepEqual((await ask('status')).result.running, false);
  assert.equal((await ask('stop')).error.code, 'invalid_input'); assert.equal((await ask('pending')).error.code, 'not_running');
  // A runtime comes up (here in this process, as an editor or the command line would start it): the extension is told.
  runtime = await startRuntime({ instanceRoot, port: 0, connectionFactory: () => ({ async start() {}, async stop() {}, status() { return { kind: 'local', status: 'ready' }; } }) });
  const told = await hear(message => message.type === 'event' && message.name === 'runtime.status' && message.data.running === true, 'the news that the runtime runs');
  assert.match(told.data.version, /^\d+\.\d+\.\d+/);
  await until(() => runtime.service.browser.status().connected, 'the browser to be linked');
  assert.deepEqual([runtime.service.browser.status().browser, runtime.service.browser.status().extension], ['Google Chrome', '4.0.5']);
  // As an entry: the status, the workbench, the MCP address, what waits; and a start that joins what already runs.
  assert.equal((await ask('start')).result.running, true);
  assert.match((await ask('workbench')).result.url, /^http:\/\/127\.0\.0\.1:\d+\/\?code=/); assert.match((await ask('mcpUrl')).result.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.deepEqual((await ask('pending')).result, { count: 0, items: [] });

  // A model's client asks for the browser through the capability tools, with no project shared at all.
  const listed = await runtime.service.call('capability.list', { engine: 'chrome' }, connected);
  assert.deepEqual([listed.engines[0].id, listed.engines[0].status, listed.engines[0].capabilities.length], ['chrome', 'connected', BROWSER_CAPABILITIES.length]);
  assert.equal((await runtime.service.call('capability.list', { name: 'chrome.bookmarks.create' }, connected)).capability.inputSchema.required.includes('title'), true);
  const reading = runtime.service.call('capability.query', { capability: 'chrome.bookmarks.search', input: { query: 'devmate' } }, connected);
  const call = await hear(message => message.type === 'call', 'the call to reach the browser');
  assert.deepEqual([call.method, call.params], ['bookmarks.search', { query: 'devmate' }]);
  say({ type: 'result', id: call.id, ok: true, result: { items: [{ id: '12', title: 'DevMate', url: 'https://github.com/Kukutx/DevMate' }], total: 1 } });
  assert.deepEqual(await reading, { items: [{ id: '12', title: 'DevMate', url: 'https://github.com/Kukutx/DevMate' }], total: 1 });
  // A change goes through the tool for changes only, and the browser's refusal comes back as it is.
  await assert.rejects(runtime.service.call('capability.query', { capability: 'chrome.bookmarks.remove', input: { id: '12' } }, connected), { code: 'forbidden' });
  const removing = runtime.service.call('capability.call', { capability: 'chrome.bookmarks.remove', input: { id: '404' } }, connected);
  const change = await hear(message => message.type === 'call', 'the change to reach the browser');
  say({ type: 'result', id: change.id, ok: false, error: { code: 'not_found', message: 'No bookmark has the id 404.' } });
  await assert.rejects(removing, { code: 'not_found', message: 'No bookmark has the id 404.' });
  // The link itself is the browser host's alone: a connected client cannot pose as a browser.
  for (const [operation, input] of [['chrome.attach', { methods: [] }], ['chrome.next', { linkId: 'x' }], ['chrome.result', { linkId: 'x', id: 'y', ok: true }], ['chrome.detach', { linkId: 'x' }]])
    await assert.rejects(runtime.service.call(operation, input, connected), { code: 'forbidden' }, operation);
  // The doctor says how the browser stands, and with a project the browser is listed beside the project's engines.
  const doctor = await runtime.service.call('runtime.doctor', {}, owner);
  assert.match(doctor.checks.find(item => item.id === 'chrome').detail, /^The DevMate extension 4\.0\.5 in Google Chrome is connected: its bookmarks, tabs, history, downloads/);
  const projectRoot = path.join(temp, 'project'); fs.mkdirSync(projectRoot);
  await runtime.service.call('project.create', { root: projectRoot }, owner);
  const everything = await runtime.service.call('capability.list', { summary: true }, connected);
  assert.deepEqual(everything.engines.at(-1).id, 'chrome'); assert.ok(everything.engines.length > 3);
  // The browser closes: the host ends, the runtime is told and keeps running.
  host.stdin.end();
  assert.equal(await new Promise(resolve => host.once('exit', resolve)), 0);
  await until(() => !runtime.service.browser.status().connected, 'the link to be gone');
  await assert.rejects(runtime.service.call('capability.query', { capability: 'chrome.tabs.list' }, connected), { code: 'browser_unavailable' });
  assert.equal(runtime.health.status, 'ready');
  assert.match((await runtime.service.call('runtime.doctor', {}, owner)).checks.find(item => item.id === 'chrome').fix, /devmate chrome install/);
});
