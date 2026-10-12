import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { BROWSER_CAPABILITIES, BROWSER_TEXT, EXTENSION_ORIGIN, NATIVE_HOST, createBrowserLink } from '../runtime/chrome.mjs';
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
  // So does every code the extension refuses with (read from its files): a script that threw, a dialog in the way and
  // a wait that ended are not faults of the browser. A code it never uses is one.
  const codes = new Set(fs.readdirSync(new URL('../chrome-extension/', import.meta.url)).filter(name => name.endsWith('.js'))
    .flatMap(name => [...fs.readFileSync(new URL('../chrome-extension/' + name, import.meta.url), 'utf8').matchAll(/fail\('([a-z_]+)'/g)].map(match => match[1])));
  assert.ok(['page_error', 'dialog_open', 'covered', 'timeout'].every(code => codes.has(code)), [...codes].join(', '));
  for (const code of [...codes, 'made_up']) {
    const failing = link.call({ capability: 'chrome.tabs.list' }, { readOnly: true }), handed = await link.next({ linkId, waitMs: 1000 });
    link.result({ linkId, id: handed.calls[0].id, ok: false, error: { code, message: 'as the extension says it' } });
    await assert.rejects(failing, { code: code === 'made_up' ? 'browser_error' : code, message: 'as the extension says it' });
  }
  // The owner paused the browser in the extension: a decision, said as one, and nothing a model should try again.
  const paused = link.call({ capability: 'chrome.tabs.list' }, { readOnly: true }), held = await link.next({ linkId, waitMs: 1000 });
  link.result({ linkId, id: held.calls[0].id, ok: false, error: { code: 'paused', message: 'whatever the extension says' } });
  await assert.rejects(paused, { code: 'paused', notStarted: true, message: /^The owner has paused DevMate's use of this browser, in the DevMate extension\. That is their decision, not a fault: do not try again/ });
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

test('a browser that is gone is noticed in a moment: its link goes, and no call is left waiting for it', async () => {
  const link = createBrowserLink({ idleMs: 80, callTimeoutMs: 10000 });
  const methods = ['tabs.list', 'tabs.close'];
  // A browser host as it behaves: it asks for work again the moment it was answered, and brings each answer back.
  const host = (linkId, name) => {
    const stop = new AbortController();
    void (async () => { while (!stop.signal.aborted) { let work; try { work = await link.next({ linkId, waitMs: 300 }, { signal: stop.signal }); } catch { return; }
      for (const call of work.calls) link.result({ linkId, id: call.id, ok: true, result: { by: name } }); } })();
    return () => stop.abort();
  };
  const quickly = async (work, what) => { const started = Date.now(), value = await work.then(result => result, failure => failure); assert.ok(Date.now() - started < 2000, what + ' took ' + (Date.now() - started) + ' ms'); return value; };
  // The owner's browser, and a second one that connected after it: calls go to the second.
  const chrome = link.attach({ browser: 'Google Chrome', extension: '4.0.5', methods }).linkId; host(chrome, 'chrome');
  const edge = link.attach({ browser: 'Microsoft Edge', extension: '4.0.5', methods }).linkId, endEdge = host(edge, 'edge');
  assert.deepEqual(await link.call({ capability: 'chrome.tabs.list' }, { readOnly: true }), { by: 'edge' });
  // The second browser is ended, and its host with it, in the middle of asking: the very next call goes to the one
  // that is there, and a moment later the link of the other is no more.
  endEdge();
  assert.deepEqual(await quickly(link.call({ capability: 'chrome.tabs.list' }, { readOnly: true }), 'the call after a browser went'), { by: 'chrome' });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual([link.status().browser, link.status().browsers], ['Google Chrome', 1]);
  await assert.rejects(async () => link.next({ linkId: edge }), { code: 'not_found' });

  // A browser whose host stopped asking without a word (it hangs, or was ended between two questions): what waits for
  // it and was not handed on yet goes to the browser that is there.
  const silent = link.attach({ browser: 'Microsoft Edge', extension: '4.0.5', methods }).linkId;
  assert.deepEqual(await quickly(link.call({ capability: 'chrome.tabs.list' }, { readOnly: true }), 'the call that waited on a browser that never asked'), { by: 'chrome' });
  await assert.rejects(async () => link.next({ linkId: silent }), { code: 'not_found' });

  // The only browser goes: a call is refused within that moment, as never begun, and not after half a minute.
  const alone = createBrowserLink({ idleMs: 80, callTimeoutMs: 10000 });
  const only = alone.attach({ browser: 'Google Chrome', extension: '4.0.5', methods }).linkId, leaving = new AbortController();
  const asking = alone.next({ linkId: only, waitMs: 5000 }, { signal: leaving.signal });
  leaving.abort(); assert.deepEqual(await asking, { calls: [] });
  const refused = await quickly(alone.call({ capability: 'chrome.tabs.list' }, { readOnly: true }), 'the refusal');
  assert.deepEqual([refused.code, refused.notStarted], ['browser_unavailable', true]); assert.match(refused.message, /closed or disconnected before it was asked \(it stopped asking for work\)/);
  assert.deepEqual(alone.status(), { connected: false });
  // One that was handed to the browser before it went is answered too, and nothing is claimed about whether it was done.
  const again = alone.attach({ browser: 'Google Chrome', extension: '4.0.5', methods }).linkId;
  const closing = alone.call({ capability: 'chrome.tabs.close', input: { tabIds: [1] } }), handed = await alone.next({ linkId: again, waitMs: 1000 });
  assert.equal(handed.calls[0].method, 'tabs.close');
  const lostAnswer = await quickly(closing, 'the answer for a call the browser took with it');
  assert.deepEqual([lostAnswer.code, lostAnswer.notStarted], ['browser_unavailable', undefined]); assert.match(lostAnswer.message, /before it answered/);
  // A host that lost one question (its connection, not its browser) and asks again in time is the browser it was.
  const back = alone.attach({ browser: 'Google Chrome', extension: '4.0.5', methods }).linkId, away = new AbortController();
  const dropped = alone.next({ linkId: back, waitMs: 5000 }, { signal: away.signal }); away.abort(); await dropped;
  const wanted = alone.call({ capability: 'chrome.tabs.list' }, { readOnly: true }), returned = await alone.next({ linkId: back, waitMs: 1000 });
  alone.result({ linkId: back, id: returned.calls[0].id, ok: true, result: { by: 'the same browser' } });
  assert.deepEqual(await wanted, { by: 'the same browser' }); assert.equal(alone.status().connected, true);
  // And one that keeps asking stays, however long nothing is asked of it.
  const steady = createBrowserLink({ idleMs: 80 }), kept = steady.attach({ browser: 'Google Chrome', extension: '4.0.5', methods }).linkId;
  for (let round = 0; round < 6; round++) { await steady.next({ linkId: kept, waitMs: 40 }); assert.equal(steady.status().connected, true); }
  alone.close(); steady.close(); link.close();
});

test('what a developer debugs a page with: answers read as lines, a wait that is given its time, and cookie values only as a change', async () => {
  const link = createBrowserLink({ callTimeoutMs: 300 });
  const { linkId } = link.attach({ browser: 'Google Chrome', extension: '4.0.5', methods: BROWSER_CAPABILITIES.map(item => item.method) });
  const answering = async (result, after = 0) => { const { calls } = await link.next({ linkId, waitMs: 2000 }); if (after) await new Promise(resolve => setTimeout(resolve, after)); link.result({ linkId, id: calls[0].id, ok: true, result }); return calls[0]; };
  // A console is read as its lines, followed by what is needed to go on; the data itself is unchanged for other callers.
  const printed = link.call({ capability: 'chrome.page.console', input: { level: 'warn' } }, { readOnly: true });
  const asked = await answering({ tabId: 7, items: [{ seq: 1, level: 'error', text: 'boom', where: 'https://x.test/app.js:12' }, { seq: 2, level: 'warn', text: 'careful' }], cursor: 2, untrusted: true });
  assert.deepEqual([asked.method, asked.params], ['page.console', { level: 'warn' }]);
  const consoleAnswer = await printed;
  assert.equal(consoleAnswer[BROWSER_TEXT], '[error] boom  (https://x.test/app.js:12)\n[warn] careful\n{"tabId":7,"cursor":2,"untrusted":true}');
  assert.deepEqual(JSON.parse(JSON.stringify(consoleAnswer)).items.length, 2);
  const requests = link.call({ capability: 'chrome.page.network', input: { failedOnly: true } }, { readOnly: true });
  await answering({ tabId: 7, items: [{ requestId: '9.1', method: 'GET', url: 'https://x.test/api', type: 'Fetch', status: 500, ms: 31 }, { requestId: '9.2', method: 'POST', url: 'https://x.test/save', type: 'XHR', failed: 'net::ERR_FAILED' }], cursor: 9, untrusted: true });
  assert.equal((await requests)[BROWSER_TEXT], '500  GET  https://x.test/api  Fetch  31 ms  requestId=9.1\nFAILED  POST  https://x.test/save  XHR  (net::ERR_FAILED)  requestId=9.2\n{"tabId":7,"cursor":9,"untrusted":true}');
  const elements = link.call({ capability: 'chrome.page.snapshot', input: { interactiveOnly: true } }, { readOnly: true });
  await answering({ tabId: 7, title: 'App', url: 'https://x.test/', text: '[12] button "Save"\n[15] textbox "Name" value="Ann"', nodes: 2, untrusted: true });
  assert.equal((await elements)[BROWSER_TEXT], '[12] button "Save"\n[15] textbox "Name" value="Ann"\n{"tabId":7,"title":"App","url":"https://x.test/","nodes":2,"untrusted":true}');
  // A picture of a whole page stays a picture, and says how large it is.
  const whole = link.call({ capability: 'chrome.page.screenshot', input: { fullPage: true } }, { readOnly: true });
  await answering({ tabId: 7, mimeType: 'image/png', base64: 'aGk=', fullPage: true, width: 1280, height: 4000 });
  assert.deepEqual((await whole).content, [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }, { type: 'text', text: '{"tabId":7,"fullPage":true,"width":1280,"height":4000}' }]);
  // Waiting for something to appear is given its own time plus a margin, not the usual limit of a call.
  const waited = link.call({ capability: 'chrome.page.waitFor', input: { text: 'Saved', timeoutMs: 400 } }, { readOnly: true });
  await answering({ tabId: 7, found: true, ms: 380 }, 450);
  assert.deepEqual(await waited, { tabId: 7, found: true, ms: 380 });
  // The names of what a page stores are a look; the values are credentials and are asked for like a change.
  await assert.rejects(link.call({ capability: 'chrome.page.storage', input: { includeValues: true } }, { readOnly: true }), { code: 'forbidden', notStarted: true, message: /hands out credentials \(the values a page stores, its cookies among them\): call it with capability_call/ });
  const names = link.call({ capability: 'chrome.page.storage' }, { readOnly: true });
  await answering({ tabId: 7, origin: 'https://x.test', cookies: [{ name: 'sid', chars: 40 }], untrusted: true });
  assert.equal((await names).cookies[0].name, 'sid');
  const values = link.call({ capability: 'chrome.page.storage', input: { includeValues: true } });
  assert.deepEqual((await answering({ tabId: 7, cookies: [] })).params, { includeValues: true }); await values;
  // One request in full: its headers and sizes first, then what came back, as it came.
  const full = link.call({ capability: 'chrome.page.networkRequest', input: { requestId: '9.1' } }, { readOnly: true });
  await answering({ tabId: 7, requestId: '9.1', method: 'GET', url: 'https://x.test/api', status: 500, responseHeaders: { 'content-type': 'application/json' }, body: '{"error":"boom"}', untrusted: true });
  assert.equal((await full)[BROWSER_TEXT], '{"tabId":7,"requestId":"9.1","method":"GET","url":"https://x.test/api","status":500,"responseHeaders":{"content-type":"application/json"},"untrusted":true}\n{"error":"boom"}');
  // What acts on a page is a change, and wrong input never reaches the browser.
  for (const capability of ['chrome.page.click', 'chrome.page.type', 'chrome.page.press', 'chrome.page.select', 'chrome.page.evaluate', 'chrome.page.reload', 'chrome.page.emulate', 'chrome.page.dialog', 'chrome.page.debugStop', 'chrome.page.scroll', 'chrome.page.hover', 'chrome.tabs.back', 'chrome.tabs.forward'])
    await assert.rejects(link.call({ capability, input: capability.endsWith('type') ? { text: 'x' } : capability.endsWith('press') ? { key: 'Enter' } : capability.endsWith('evaluate') ? { expression: '1' } : capability.endsWith('dialog') ? { accept: true } : {} }, { readOnly: true }), { code: 'forbidden' }, capability);
  await assert.rejects(link.call({ capability: 'chrome.page.press', input: { key: 'F13' } }), { code: 'invalid_input' });
  await assert.rejects(link.call({ capability: 'chrome.page.press', input: { key: 's', modifiers: ['hyper'] } }), { code: 'invalid_input' });
  await assert.rejects(link.call({ capability: 'chrome.page.evaluate', input: { expression: '' } }), { code: 'invalid_input' });
  link.close();
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
  // Written from inside an app that Windows gives a registry of its own: this program reads its registration back, and
  // no browser can. That is said as what it is, never as "registered", and taking it away clears that copy too.
  const own = new Map(windows.files ? [['HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + NATIVE_HOST, windows.files.manifest]] : []), ownCalls = [];
  const apartRun = async (tool, args) => { ownCalls.push(args.slice(0, 2).join(' ')); if (args[0] === 'query') return own.has(args[1]) ? { code: 0, stdout: '    (Default)    REG_SZ    ' + own.get(args[1]) + '\r\n', stderr: '' } : { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'delete') { own.delete(args[1]); return { code: 0, stdout: '', stderr: '' }; } throw new Error('unexpected ' + args.join(' ')); };
  const nothing = { read: async names => names.map(() => null), write: async names => names.map(() => 0), remove: async names => names.map(() => 2) };
  const apart = createChromeRegistration({ instanceRoot: root, cli: program, node: process.execPath, platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, registry: nothing, run: apartRun });
  assert.deepEqual(await apart.status(), { registered: false, supported: true, browsers: [], host: NATIVE_HOST, extension: EXTENSION_ORIGIN, unseen: true });
  assert.equal((await apart.status({ ask: false })).unseen, undefined, 'a quick look does not go asking');
  // The file names the program and the one extension that may start it; the program is this Node with this DevMate.
  assert.deepEqual(JSON.parse(fs.readFileSync(windows.files.manifest, 'utf8')), { name: NATIVE_HOST, description: 'DevMate: the runtime on this computer, for the DevMate browser extension.', path: windows.files.shim, type: 'stdio', allowed_origins: [EXTENSION_ORIGIN] });
  assert.equal(fs.readFileSync(windows.files.shim, 'utf8'), '@echo off\r\n"' + process.execPath + '" "' + program + '" chrome-host --instance "' + path.resolve(root).replace(/%/g, '%%') + '" %*\r\n');
  // The copy of DevMate it names is gone: said, with nothing else changed.
  fs.rmSync(program); assert.equal((await windows.status()).stale, true); fs.writeFileSync(program, '');
  assert.deepEqual([(await windows.uninstall()).registered, [...keys.values()], fs.existsSync(path.dirname(windows.files.manifest))], [false, ['C:\\elsewhere\\' + NATIVE_HOST + '.json'], false], 'a key that names another instance\'s file is left where it is');
  fs.mkdirSync(path.dirname(windows.files.manifest), { recursive: true }); fs.writeFileSync(windows.files.manifest, '{}'); fs.writeFileSync(windows.files.shim, '');
  assert.equal((await apart.uninstall()).unseen, undefined); assert.equal(own.size, 0, 'the copy only this program could see is gone as well'); assert.ok(ownCalls.some(call => call.startsWith('delete HKCU\\Software\\Google\\Chrome')));

  // Elsewhere the same file lies in the folder of each browser that is installed, and the program is a shell script.
  fs.mkdirSync(path.join(home, '.config', 'microsoft-edge'), { recursive: true });
  const linux = createChromeRegistration({ instanceRoot: root, cli: program, node: '/opt/node 24/bin/node', platform: 'linux', home, run });
  const there = await linux.install();
  assert.deepEqual(there.browsers, ['Chrome', 'Edge']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts', NATIVE_HOST + '.json'), 'utf8')).path, linux.files.shim);
  assert.equal(fs.readFileSync(linux.files.shim, 'utf8'), '#!/bin/sh\nexec \'/opt/node 24/bin/node\' \'' + program + '\' \'chrome-host\' \'--instance\' \'' + path.resolve(root) + '\' "$@"\n');
  assert.equal(fs.existsSync(path.join(home, '.config', 'chromium')), false, 'a browser that is not installed gets no folder');
  // Another instance registered itself with Edge after this one: its file is in the same place under the same name,
  // names its own program, and is not this instance's to take away.
  const theirs = path.join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts', NATIVE_HOST + '.json'), other = JSON.stringify({ name: NATIVE_HOST, path: '/elsewhere/devmate-chrome-host', type: 'stdio', allowed_origins: [EXTENSION_ORIGIN] });
  fs.writeFileSync(theirs, other);
  assert.equal((await linux.uninstall()).registered, false); assert.equal(fs.readFileSync(theirs, 'utf8'), other);
  assert.equal(fs.existsSync(path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts', NATIVE_HOST + '.json')), false, 'its own is gone');
  assert.deepEqual(await createChromeRegistration({ instanceRoot: root, cli: program, platform: 'freebsd', run }).status(), { registered: false, supported: false });

  // The command: the owner's to run, and it says what is left to do in the browser.
  let state = { registered: false, supported: true, browsers: [] };
  const kept = path.join(root, 'chrome', 'extension');
  const fake = { status: async () => state, install: async () => (state = { registered: true, supported: true, browsers: ['Chrome', 'Edge'], folder: kept }), uninstall: async () => (state = { registered: false, supported: true, browsers: [] }) };
  const command = async (args, env = {}) => { const stdout = output(), stderr = output(); const code = await cli([...args, '--instance', root], { stdout, stderr, env, browserHost: async () => fake }); return { code, out: stdout.text, err: stderr.text }; };
  assert.match(JSON.parse((await command(['chrome'])).out).next[0], /devmate chrome install/);
  const done = JSON.parse((await command(['chrome', 'install'])).out);
  assert.equal(done.registered, true); assert.match(done.next[0], /chrome:\/\/extensions .* "Load unpacked" and pick /); assert.ok(done.next[0].includes('pick ' + kept + '. Leave Developer mode on'), done.next[0]);
  for (const action of ['install', 'uninstall']) { const refused = await command(['chrome', action], { DEVMATE_CLIENT_COMMAND: '1' }); assert.notEqual(refused.code, 0); assert.match(refused.err, /run by the owner in their own terminal/); }
  assert.equal(JSON.parse((await command(['chrome', 'uninstall'])).out).registered, false);
});

test('a registered browser is given the extension in a folder that stays, and a start of the runtime makes that folder and the host the DevMate that runs', { timeout: 60000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-chrome-folder-')), root = path.join(temp, 'instance'), home = path.join(temp, 'home');
  let runtime;
  t.after(async () => { await runtime?.stop(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  // Copies of DevMate as the versions of an editor's extension are: each in a folder of its own, with its own extension.
  const copy = (name, files) => {
    const base = path.join(temp, name); fs.mkdirSync(path.join(base, 'runtime'), { recursive: true }); fs.writeFileSync(path.join(base, 'runtime', 'cli.mjs'), '');
    for (const [file, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(base, 'chrome-extension', file)), { recursive: true }); fs.writeFileSync(path.join(base, 'chrome-extension', file), content); }
    return path.join(base, 'runtime', 'cli.mjs');
  };
  const first = copy('devmate-1', { 'manifest.json': '{"version":"1"}', 'background.js': 'one', 'old.js': 'not in the next version', 'icons/16.png': 'a picture' });
  const second = copy('devmate-2', { 'manifest.json': '{"version":"2"}', 'background.js': 'two', 'icons/16.png': 'a picture' });
  const node = path.join(temp, 'node'), editor = path.join(temp, 'Code.exe'); fs.writeFileSync(node, ''); fs.writeFileSync(editor, '');
  const run = async () => { throw new Error('nothing is started in this test'); };
  const registration = (cli, program = node) => createChromeRegistration({ instanceRoot: root, cli, node: program, platform: 'linux', home, run });
  const folder = registration(first).files.extension, held = name => { try { return fs.readFileSync(path.join(folder, name), 'utf8'); } catch { return null; } };
  assert.equal(folder, path.join(path.resolve(root), 'chrome', 'extension'));
  // Nothing is registered: a start of the runtime writes nothing.
  assert.deepEqual(registration(first).refresh(), { refreshed: false }); assert.equal(fs.existsSync(path.join(root, 'chrome')), false);
  // Registering puts the extension there, and says where: that is the folder the owner gives the browser.
  assert.equal((await registration(first).install()).folder, folder);
  assert.deepEqual(['manifest.json', 'background.js', 'old.js', 'icons/16.png'].map(held), ['{"version":"1"}', 'one', 'not in the next version', 'a picture']);
  assert.deepEqual(registration(first).refresh(), { refreshed: true, host: false, extension: false }, 'the same copy starting again changes nothing');
  // DevMate is updated into another folder and its runtime starts, run by an editor's own program: the browser's
  // folder holds the new extension and nothing of the old, and the host is the new copy, started with the Node it
  // was registered with (the editor's program is no Node to start).
  assert.deepEqual(registration(second, editor).refresh(), { refreshed: true, host: true, extension: true });
  assert.deepEqual(['manifest.json', 'background.js', 'old.js', 'icons/16.png'].map(held), ['{"version":"2"}', 'two', null, 'a picture']);
  const shim = fs.readFileSync(registration(second).files.shim, 'utf8');
  assert.ok(shim.includes(node) && shim.includes(second) && !shim.includes(first) && !shim.includes(editor), shim);
  // A runtime that has no command line beside it (built into another program) leaves what the browser starts as it is.
  assert.deepEqual(registration(path.join(temp, 'built-in', 'cli.mjs')).refresh(), { refreshed: true, host: false, extension: false }); assert.equal(fs.readFileSync(registration(second).files.shim, 'utf8'), shim);
  fs.rmSync(path.join(temp, 'devmate-1'), { recursive: true, force: true });
  assert.deepEqual([(await registration(second).status()).stale, (await registration(second).status()).folder], [undefined, folder], 'the old copy may go: nothing names it any more');
  // The Node it was registered with is gone: no other program is put in its place (the doctor says to register again).
  const third = copy('devmate-3', { 'manifest.json': '{"version":"3"}', 'background.js': 'three' });
  fs.rmSync(node);
  assert.deepEqual(registration(third, editor).refresh(), { refreshed: true, host: false, extension: true });
  assert.equal(fs.readFileSync(registration(third).files.shim, 'utf8'), shim); assert.equal((await registration(third).status()).stale, true); assert.equal(held('manifest.json'), '{"version":"3"}');
  // An older DevMate that starts leaves a newer extension alone; the same version with other content is its own to set.
  assert.deepEqual(registration(second, editor).refresh(), { refreshed: true, host: false, extension: false }); assert.deepEqual([held('manifest.json'), held('background.js')], ['{"version":"3"}', 'three']);
  const rebuilt = copy('devmate-3b', { 'manifest.json': '{"version":"3"}', 'background.js': 'three, built again' });
  assert.deepEqual(registration(rebuilt, editor).refresh(), { refreshed: true, host: false, extension: true }); assert.equal(held('background.js'), 'three, built again');
  // The runtime itself does this when it starts: here the one of this repository, with the extension it carries.
  fs.writeFileSync(node, '');
  runtime = await startRuntime({ instanceRoot: root, port: 0, connectionFactory: () => ({ async start() {}, async stop() {}, status() { return { kind: 'local', status: 'ready' }; } }) });
  assert.equal(JSON.parse(held('manifest.json')).name, 'DevMate'); assert.equal(held('background.js'), fs.readFileSync(new URL('../chrome-extension/background.js', import.meta.url), 'utf8'));
  const started = fs.readFileSync(path.join(root, 'chrome', process.platform === 'win32' ? 'devmate-chrome-host.cmd' : 'devmate-chrome-host'), 'utf8');
  assert.ok(started.includes(fileURLToPath(new URL('../runtime/cli.mjs', import.meta.url))) && started.includes(node), started);
  await runtime.stop(); runtime = null;
  // Taking the registration away takes the folder with it.
  await registration(third).uninstall(); assert.equal(fs.existsSync(folder), false);
});

test('a browser that is ended without closing leaves no link behind: the runtime knows within seconds, end to end', { timeout: 60000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-chrome-gone-')), instanceRoot = path.join(temp, 'instance');
  let runtime, host;
  t.after(async () => { host?.kill(); await runtime?.stop(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  runtime = await startRuntime({ instanceRoot, port: 0, connectionFactory: () => ({ async start() {}, async stop() {}, status() { return { kind: 'local', status: 'ready' }; } }) });
  host = spawn(process.execPath, [fileURLToPath(new URL('../runtime/cli.mjs', import.meta.url)), 'chrome-host', EXTENSION_ORIGIN, '--parent-window=0', '--instance', instanceRoot], { stdio: ['pipe', 'pipe', 'pipe'] });
  host.stdout.on('data', () => {}); host.stderr.on('data', () => {});
  host.stdin.write(frame({ type: 'hello', protocol: 1, extension: '4.0.5', browser: 'Google Chrome', methods: BROWSER_CAPABILITIES.map(item => item.method) }));
  await until(() => runtime.service.browser.status().connected, 'the browser to be linked');
  // The browser's process is ended, and its host with it: no goodbye is said. A call made at that moment is refused
  // within seconds, as never begun, instead of waiting half a minute for an answer nobody will bring.
  const ended = new Promise(resolve => host.once('exit', resolve));
  host.kill(); await ended;
  const started = Date.now();
  await assert.rejects(runtime.service.call('capability.query', { capability: 'chrome.tabs.list' }, connected), { code: 'browser_unavailable' });
  assert.ok(Date.now() - started < 12000, 'refused after ' + (Date.now() - started) + ' ms');
  assert.deepEqual(runtime.service.browser.status(), { connected: false });
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
  assert.match((await ask('workbench')).result.url, /^http:\/\/127\.0\.0\.1:\d+\/\?code=/); const address = (await ask('mcpUrl')).result;
  // No public route is configured here: the address is this computer's own, and says so.
  assert.match(address.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/); assert.equal(address.scope, 'local');
  assert.deepEqual((await ask('pending')).result, { count: 0, items: [] });

  // A model's client asks for the browser through the capability tools, with no project shared at all.
  const listed = await runtime.service.call('capability.list', { engine: 'chrome' }, connected);
  assert.deepEqual([listed.engines[0].id, listed.engines[0].status, listed.engines[0].capabilities.length], ['chrome', 'connected', BROWSER_CAPABILITIES.length]);
  assert.equal((await runtime.service.call('capability.list', { name: 'chrome.bookmarks.create' }, connected)).capability.inputSchema.required.includes('title'), true);
  // A capability is found by words in its name or its description; an engine that has none of them is left out.
  const found = await runtime.service.call('capability.list', { engine: 'chrome', query: 'bookmarks search' }, connected);
  assert.deepEqual(found.engines.map(item => [item.id, item.capabilities.map(one => one.name)]), [['chrome', ['chrome.bookmarks.search']]]);
  // The words are looked for in the description too, and a name is found however its parts are joined.
  const consoles = (await runtime.service.call('capability.list', { engine: 'chrome', query: 'page_console' }, connected)).engines[0].capabilities;
  assert.ok(consoles.some(one => one.name === 'chrome.page.console') && consoles.length < 6 && consoles.every(one => /console/i.test(one.name + one.description)), consoles.map(one => one.name).join());
  assert.deepEqual((await runtime.service.call('capability.list', { engine: 'chrome', query: 'no such thing anywhere' }, connected)).engines, []);
  // And an operation the same way.
  const operations = (await runtime.service.call('operations.list', { query: 'history' }, connected)).items.map(item => item.name);
  assert.ok(operations.includes('workspace.history') && operations.length < 12 && !operations.includes('workspace.read'), operations.join());
  const named = (await runtime.service.call('operations.list', { query: 'workspace_history' }, connected)).items;
  assert.ok(named.some(item => item.name === 'workspace.history') && named.length < 8 && named.every(item => /workspace/i.test(item.name + item.description) && /history/i.test(item.name + item.description)), named.map(item => item.name).join());
  assert.deepEqual((await runtime.service.call('operations.list', { query: 'no such thing anywhere' }, connected)).items, []);
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
  // A model's client is given a console as lines, through the tool it knows.
  const model = new Client({ name: 'openai-mcp', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await model.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + runtime.port + '/mcp')));
  const looking = model.callTool({ name: 'capability_query', arguments: { capability: 'chrome.page.console' } });
  const look = await hear(message => message.type === 'call', 'the look at the console to reach the browser');
  say({ type: 'result', id: look.id, ok: true, result: { tabId: 7, items: [{ seq: 1, level: 'error', text: 'boom' }], cursor: 1, untrusted: true } });
  assert.equal((await looking).content[0].text, '[error] boom\n{"tabId":7,"cursor":1,"untrusted":true}');
  await model.close();
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
