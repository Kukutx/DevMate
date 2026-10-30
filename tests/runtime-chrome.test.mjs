import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { BROWSER_CAPABILITIES, BROWSER_TEXT, EXTENSION_ORIGIN, NATIVE_HOST, createBrowserLink } from '../runtime/chrome.mjs';
import { PassThrough } from 'node:stream';
import { frame, frames, serveChromeHost } from '../runtime/chrome-host.mjs';
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
  assert.deepEqual((await link.next({ linkId, waitMs: 10 })).calls, []);
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
  const quickly = async (work, what) => { const started = Date.now(), value = await work.then(result => result, failure => failure); assert.ok(Date.now() - started < 5000, what + ' took ' + (Date.now() - started) + ' ms'); return value; };
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

  // A browser that has connected and has not asked for work yet is not what a call waits for while another browser
  // is there: the call is answered at once. If it never asks, its link goes after the moment it is given.
  const silent = link.attach({ browser: 'Microsoft Edge', extension: '4.0.5', methods }).linkId;
  assert.deepEqual(await quickly(link.call({ capability: 'chrome.tabs.list' }, { readOnly: true }), 'the call beside a browser that has not asked yet'), { by: 'chrome' });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(link.status().browsers, 1);
  await assert.rejects(async () => link.next({ linkId: silent }), { code: 'not_found' });
  // Alone, such a browser is what there is: the call waits for it, and is its to answer once it asks.
  const late = createBrowserLink({ idleMs: 1500, callTimeoutMs: 10000 }), slow = late.attach({ browser: 'Google Chrome', extension: '4.0.5', methods }).linkId;
  const waited = late.call({ capability: 'chrome.tabs.list' }, { readOnly: true });
  await new Promise(resolve => setTimeout(resolve, 60));
  const given = await late.next({ linkId: slow, waitMs: 1000 });
  late.result({ linkId: slow, id: given.calls[0].id, ok: true, result: { by: 'the browser that asked late' } });
  assert.deepEqual(await waited, { by: 'the browser that asked late' });
  late.close();

  // The only browser goes: a call is refused within that moment, as never begun, and not after half a minute.
  // (The moments here are a few hundred milliseconds: long enough that a busy computer running the tests does not
  // lose a browser that is still there, short enough to tell them from the half minute a call would wait.)
  const alone = createBrowserLink({ idleMs: 300, callTimeoutMs: 10000 });
  const only = alone.attach({ browser: 'Google Chrome', extension: '4.0.5', methods }).linkId, leaving = new AbortController();
  const asking = alone.next({ linkId: only, waitMs: 5000 }, { signal: leaving.signal });
  leaving.abort(); assert.deepEqual((await asking).calls, []);
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
  const steady = createBrowserLink({ idleMs: 500 }), kept = steady.attach({ browser: 'Google Chrome', extension: '4.0.5', methods }).linkId;
  for (let round = 0; round < 5; round++) { await steady.next({ linkId: kept, waitMs: 150 }); assert.equal(steady.status().connected, true); }
  // A host that took calls and was not heard of again (it was ended while it was being answered): a call that only
  // reads goes to the browser that is there; a change is not asked for twice, and is answered when the link goes,
  // with nothing claimed about whether it was done.
  const taker = createBrowserLink({ idleMs: 1000, unheardMs: 100, callTimeoutMs: 10000 }), there = taker.attach({ browser: 'Google Chrome', extension: '4.0.5', methods }).linkId, asked = [];
  void (async () => { for (;;) { let work; try { work = await taker.next({ linkId: there, waitMs: 300 }); } catch { return; }
    for (const call of work.calls) { asked.push(call.method); taker.result({ linkId: there, id: call.id, ok: true, result: { by: 'the browser that is there' } }); } } })();
  const ended = taker.attach({ browser: 'Microsoft Edge', extension: '4.0.5', methods }).linkId;
  assert.deepEqual((await taker.next({ linkId: ended, waitMs: 10 })).calls, []);
  // (It has answered a look, so that ids are its own: see the test of a call that names an id before any answer.)
  { const seen = taker.call({ capability: 'chrome.tabs.list' }, { readOnly: true }), work = await taker.next({ linkId: ended, waitMs: 1000 }); taker.result({ linkId: ended, id: work.calls[0].id, ok: true, result: {} }); await seen; }
  const read = taker.call({ capability: 'chrome.tabs.list' }, { readOnly: true }), change = taker.call({ capability: 'chrome.tabs.close', input: { tabIds: [7] } });
  assert.deepEqual((await taker.next({ linkId: ended, waitMs: 1000 })).calls.map(call => call.method), ['tabs.list', 'tabs.close']);
  assert.deepEqual(await quickly(read, 'the read a host took with it'), { by: 'the browser that is there' });
  const unknown = await quickly(change, 'the change a host took with it');
  assert.deepEqual([unknown.code, unknown.notStarted], ['browser_unavailable', undefined]);
  assert.match(unknown.message, /before it answered \(it stopped asking for work\)\. Whether it was done is not known: look before repeating it\./);
  assert.deepEqual(asked, ['tabs.list'], 'the change was not asked of the other browser');
  // A look that the browser had taken, and whose host has asked for work again since (which is all that is known of a
  // call by then), is asked of the other browser when the first one goes for good. It was left where it was, and
  // told that the other browser could not be given it, which that one could.
  const pair = createBrowserLink({ idleMs: 5000, unheardMs: 5000, callTimeoutMs: 10000 }), other = pair.attach({ browser: 'Google Chrome', extension: '4.0.5', methods }).linkId, askedOfOther = [];
  void (async () => { for (;;) { let work; try { work = await pair.next({ linkId: other, waitMs: 300 }); } catch { return; }
    for (const call of work.calls) { askedOfOther.push(call.method); pair.result({ linkId: other, id: call.id, ok: true, result: { by: 'the browser that is there' } }); } } })();
  const going = pair.attach({ browser: 'Microsoft Edge', extension: '4.0.5', methods }).linkId;
  assert.deepEqual((await pair.next({ linkId: going, waitMs: 10 })).calls, []);
  // (It has answered a look, so that ids are its own: see the test of a call that names an id before any answer.)
  { const seen = pair.call({ capability: 'chrome.tabs.list' }, { readOnly: true }), work = await pair.next({ linkId: going, waitMs: 1000 }); pair.result({ linkId: going, id: work.calls[0].id, ok: true, result: {} }); await seen; }
  const look = pair.call({ capability: 'chrome.tabs.list' }, { readOnly: true }), gone = pair.call({ capability: 'chrome.tabs.close', input: { tabIds: [7] } });
  assert.deepEqual((await pair.next({ linkId: going, waitMs: 1000 })).calls.map(call => call.method), ['tabs.list', 'tabs.close']);
  void pair.next({ linkId: going, waitMs: 5000 });
  pair.detach({ linkId: going });
  assert.deepEqual(await quickly(look, 'the look a browser had taken'), { by: 'the browser that is there' });
  // The change it had taken is not asked for twice, and nothing is claimed about whether it was done.
  const undone = await quickly(gone, 'the change a browser had taken');
  assert.deepEqual([undone.code, undone.notStarted, askedOfOther], ['browser_unavailable', undefined, ['tabs.list']]);
  assert.match(undone.message, /before it answered \(the browser was closed\)\. Whether it was done is not known: look before repeating it\. A browser is connected now, and this call was not passed on to it: it changes something/);
  pair.close(); taker.close(); alone.close(); steady.close(); link.close();
});

// With Chrome and Edge both connected, a model holds ids it got from one of them. When that one goes, a call that
// waited for it went to the other, where tab 57 and bookmark 57 are other things, and was answered as done.
test('a call that names something of one browser is not passed on to another, and a call is listened for only until it is answered', async () => {
  const link = createBrowserLink({ idleMs: 250, unheardMs: 40, callTimeoutMs: 10000 });
  const methods = ['tabs.list', 'tabs.close', 'tabs.open', 'bookmarks.remove', 'bookmarks.tree', 'page.read', 'page.console', 'page.storage'];
  // The browser that stays answers whatever it is asked, and writes down what that was.
  const stays = link.attach({ browser: 'Google Chrome', extension: '4.0.5', methods }).linkId, asked = [];
  void (async () => { for (;;) { let work; try { work = await link.next({ linkId: stays, waitMs: 300 }); } catch { return; }
    for (const call of work.calls) { asked.push(call.method); link.result({ linkId: stays, id: call.id, ok: true, result: { by: 'the browser that stays' } }); } } })();
  // The one that connected after it asked for work once and is not heard of again: what is asked now waits for it.
  const goes = link.attach({ browser: 'Microsoft Edge', extension: '4.0.5', methods: [...methods, 'history.search'] }).linkId;
  assert.deepEqual((await link.next({ linkId: goes, waitMs: 10 })).calls, []);
  // (It has answered a look, so that ids are its own: see the test of a call that names an id before any answer.)
  { const seen = link.call({ capability: 'chrome.tabs.list' }, { readOnly: true }), work = await link.next({ linkId: goes, waitMs: 1000 }); link.result({ linkId: goes, id: work.calls[0].id, ok: true, result: {} }); await seen; }
  const calls = {
    list: link.call({ capability: 'chrome.tabs.list', input: { query: 'docs' } }, { readOnly: true }),
    history: link.call({ capability: 'chrome.history.search', input: { query: 'docs' } }, { readOnly: true }),
    tree: link.call({ capability: 'chrome.bookmarks.tree', input: { folderId: '57' } }, { readOnly: true }),
    read: link.call({ capability: 'chrome.page.read', input: { tabId: 57 } }, { readOnly: true }),
    console: link.call({ capability: 'chrome.page.console', input: { since: 12 } }, { readOnly: true }),
    values: link.call({ capability: 'chrome.page.storage', input: { includeValues: true } }),
    close: link.call({ capability: 'chrome.tabs.close', input: { tabIds: [57] } }),
    remove: link.call({ capability: 'chrome.bookmarks.remove', input: { id: '57' } }),
    open: link.call({ capability: 'chrome.tabs.open', input: { url: 'https://example.com/' } })
  };
  const settled = Object.fromEntries(await Promise.all(Object.entries(calls).map(async ([name, call]) => [name, await call.then(value => value, failure => failure)])));
  // A look that names nothing of that browser is answered by the one that is there.
  assert.deepEqual(settled.list, { by: 'the browser that stays' });
  // Whatever names a tab, a folder, a place in a console by its id is that browser's, and a change is made where it
  // was asked: neither was begun, and each is told why it stayed behind and what to do. What is said holds whether
  // the browser that is there is another one or the same one connected anew, which cannot be told from here.
  for (const name of ['tree', 'read', 'console']) {
    assert.deepEqual([settled[name].code, settled[name].notStarted], ['browser_unavailable', true], name);
    assert.match(settled[name].message, /before it was asked \(it stopped asking for work\)\. A browser is connected now, and this call was not passed on to it: it names something by an id \(a tab, a window, a bookmark, an element\), and it cannot be told from here that this is the browser the id came from\. Ask the browser that is there what it has \(tabs\.list, bookmarks\.tree\), then call again\.$/, name);
  }
  for (const name of ['close', 'remove', 'open']) {
    assert.deepEqual([settled[name].code, settled[name].notStarted], ['browser_unavailable', true], name);
    assert.match(settled[name].message, /this call was not passed on to it: it changes something, and it cannot be told from here that this is the browser it was meant for\./, name);
  }
  // Values a page stores are credentials: not handed out by another browser than the one that was asked, and the
  // call is told that, not that it named an id.
  assert.deepEqual([settled.values.code, settled.values.notStarted], ['browser_unavailable', true]);
  assert.match(settled.values.message, /this call was not passed on to it: it hands out what a page stores, and it cannot be told from here that this is the browser it was meant for\./);
  // A look that could have gone anywhere, and that the browser that is there cannot be given (its extension has no
  // such method), says that.
  assert.deepEqual([settled.history.code, settled.history.notStarted], ['browser_unavailable', true]);
  assert.match(settled.history.message, /A browser is connected, but this call could not be passed on to it: it has not asked for work yet, or its extension has no such method\. Call again\.$/);
  assert.deepEqual(asked, ['tabs.list'], 'nothing else reached the other browser');

  // Whoever asks may give a call up, and is listened to for as long as the call is open, not longer: a caller at this
  // computer gives one signal for as long as the runtime runs.
  let listening = 0, most = 0;
  const signal = { aborted: false, addEventListener() { most = Math.max(most, ++listening); }, removeEventListener() { listening--; } };
  for (let round = 0; round < 12; round++) assert.deepEqual(await link.call({ capability: 'chrome.tabs.list' }, { readOnly: true, signal }), { by: 'the browser that stays' });
  assert.deepEqual([most, listening], [1, 0]);

  // The runtime stopping takes every browser's calls with it, and says that: no browser went away, and with two
  // connected the calls of the first are not told to turn to the second.
  link.close();
  const ending = createBrowserLink({ idleMs: 5000, unheardMs: 5000, callTimeoutMs: 10000 });
  const first = ending.attach({ browser: 'Google Chrome', extension: '4.0.5', methods }).linkId;
  assert.deepEqual((await ending.next({ linkId: first, waitMs: 10 })).calls, []);
  // (It has answered a look, so that ids are its own: see the test of a call that names an id before any answer.)
  { const seen = ending.call({ capability: 'chrome.tabs.list' }, { readOnly: true }), work = await ending.next({ linkId: first, waitMs: 1000 }); ending.result({ linkId: first, id: work.calls[0].id, ok: true, result: {} }); await seen; }
  ending.attach({ browser: 'Microsoft Edge', extension: '4.0.5', methods });
  const waits = ending.call({ capability: 'chrome.tabs.close', input: { tabIds: [57] } }).then(value => value, failure => failure);
  ending.close();
  const stopped = await waits;
  assert.deepEqual([stopped.code, stopped.notStarted, stopped.message], ['browser_unavailable', true, 'DevMate is stopping: the browser was not asked.']);
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
  assert.equal(fs.readFileSync(windows.files.shim, 'utf8'), '@echo off\r\nchcp 65001 >nul 2>&1\r\n"' + process.execPath + '" "' + program + '" chrome-host --instance "' + path.resolve(root).replace(/%/g, '%%') + '" %*\r\n');
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

test('what the browser starts on Windows starts where the home directory is not written in ASCII', { skip: process.platform !== 'win32' && 'a command file is what Windows starts', timeout: 60000 }, async t => {
  // A command file is read by cmd.exe in the code page of the system, not as the UTF-8 it is written in. With the
  // owner's home, the instance or DevMate itself under a name in Chinese, the paths in it came out as other
  // characters: the browser started nothing, and the extension could only say that DevMate was not there.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-chrome-')), home = path.join(temp, '用户 张三'), root = path.join(home, '.devmate', 'runtime'), tools = path.join(home, 'tools & more');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(tools, { recursive: true });
  // (A stand-in for the command line: it writes down what it was started with.)
  const program = path.join(tools, 'cli.mjs'), seen = path.join(temp, 'seen.json');
  fs.writeFileSync(program, 'import fs from "node:fs"; fs.writeFileSync(' + JSON.stringify(seen) + ', JSON.stringify(process.argv.slice(2)));\n');
  const registry = { read: async names => names.map(() => null), write: async names => names.map(() => 0), remove: async names => names.map(() => 0) };
  const registration = createChromeRegistration({ instanceRoot: root, cli: program, node: process.execPath, registry, home });
  await registration.install();
  // As a browser starts a host: through cmd.exe, with who is asking after it.
  const ended = await new Promise(resolve => { const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', registration.files.shim, EXTENSION_ORIGIN, '--parent-window=0'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let said = ''; child.stdout.on('data', chunk => { said += chunk; }); child.stderr.on('data', chunk => { said += chunk; }); child.on('close', code => resolve({ code, said })); });
  assert.equal(ended.code, 0, ended.said);
  // Nothing but the host itself writes to the browser: what it reads there is the protocol.
  assert.equal(ended.said, '');
  assert.deepEqual(JSON.parse(fs.readFileSync(seen, 'utf8')), ['chrome-host', '--instance', root, EXTENSION_ORIGIN, '--parent-window=0']);
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

// The extension knows DevMate's own workbench by the local port the runtime says it answers the owner on. A runtime of
// the same version that was started again on another port is another origin: the extension is told.
test('the browser host says which local port the runtime answers on, and says so again when only that has changed', async () => {
  const input = new PassThrough(), output = new PassThrough(), heard = [];
  output.on('data', frames(message => heard.push(message)));
  let port = 8788;
  const client = { status: async () => ({ running: true, record: { version: '4.0.5', port } }),
    call: async name => name === 'chrome.attach' ? { linkId: 'link' } : name === 'chrome.next' ? new Promise(resolve => setTimeout(() => resolve({ calls: [] }), 40)) : { items: [] } };
  const served = serveChromeHost({ origin: EXTENSION_ORIGIN, input, output, client, pollMs: 20 });
  input.write(frame({ type: 'hello', protocol: 1, extension: '4.0.5', browser: 'Google Chrome', methods: [] }));
  await until(() => heard.some(message => message.type === 'ready'), 'ready');
  assert.deepEqual(heard.find(message => message.type === 'ready').runtime, { running: true, version: '4.0.5', port: 8788 });
  port = 9001;
  await until(() => heard.some(message => message.name === 'runtime.status' && message.data.port === 9001), 'the news of the other port');
  assert.deepEqual(heard.filter(message => message.name === 'runtime.status').at(-1).data, { running: true, version: '4.0.5', port: 9001 });
  // The folder the runtime was started from is gone under it: said when it becomes so, as what it is.
  client.status = async () => ({ running: true, record: { version: '4.0.5', port }, health: { filesGone: true } });
  await until(() => heard.some(message => message.name === 'runtime.status' && message.data.filesGone === true), 'the news that its files are gone');
  assert.deepEqual(heard.filter(message => message.name === 'runtime.status').at(-1).data, { running: true, version: '4.0.5', port: 9001, filesGone: true });
  // A runtime that does not run has no port to say.
  client.status = async () => ({ running: false });
  await until(() => heard.some(message => message.name === 'runtime.status' && message.data.running === false), 'the news that it stopped');
  assert.equal(heard.filter(message => message.name === 'runtime.status').at(-1).data.port, undefined);
  input.end(); await served;
});

test('a browser the owner paused is not the one in use either while none of them has asked for work yet', () => {
  // The moment after a start: two browsers are attached and neither has asked once. The one that connected last is
  // paused, and was said to be the one in use all the same.
  const link = createBrowserLink({ callTimeoutMs: 2000 }), methods = ['tabs.list'];
  link.attach({ browser: 'Chrome A', extension: '4.0.6', methods });
  link.attach({ browser: 'Chrome B', extension: '4.0.6', methods, paused: true });
  const status = link.status();
  assert.deepEqual(status.connections.map(one => [one.browser, one.current, one.paused]), [['Chrome A', true, undefined], ['Chrome B', undefined, true]]);
  assert.equal(status.paused, undefined);
  link.close();
});

test('a browser that is lost sight of, and one that is back, changes who is used: a host that waits is told in that moment', async () => {
  const link = createBrowserLink({ callTimeoutMs: 2000 }), methods = ['tabs.list'];
  const soon = answer => Promise.race([answer, new Promise((resolve, reject) => setTimeout(() => reject(new Error('the host that waited was not told')), 1000))]);
  const a = link.attach({ browser: 'Chrome A', extension: '4.0.6', methods }).linkId;
  await link.next({ linkId: a, waitMs: 1000 });
  const b = link.attach({ browser: 'Chrome B', extension: '4.0.6', methods }).linkId;
  await link.next({ linkId: b, waitMs: 1000 });
  // B is used. Its host goes away in the middle of asking: A is used, and its host hears it now, not in 25 seconds.
  let waiting = link.next({ linkId: a, waitMs: 5000 });
  const away = new AbortController();
  const asking = link.next({ linkId: b, waitMs: 5000 }, { signal: away.signal });
  away.abort();
  await asking;
  assert.deepEqual(await soon(waiting), { calls: [], current: true, browsers: 2 });
  // B asks again: it is used again, and A is told so.
  waiting = link.next({ linkId: a, waitMs: 5000 });
  const back = link.next({ linkId: b, waitMs: 5000 });
  assert.deepEqual(await soon(waiting), { calls: [], current: false, browsers: 2 });
  link.close(); await back;
});

test('a call that names something by an id goes to no other browser than the one that answered before: not after a pause, a choice or a new browser', async () => {
  // Tab 57 and bookmark 12 are one browser's own: in another browser the same number is something else. Pausing the
  // browser that answered, choosing another, or one more coming made the next call that names an id go to another
  // browser, and close a tab there that nobody meant.
  const link = createBrowserLink({ callTimeoutMs: 2000 }), methods = ['tabs.list', 'tabs.close'];
  const a = link.attach({ browser: 'Chrome A', extension: '4.0.6', methods }).linkId;
  await link.next({ linkId: a, waitMs: 1000 });
  const b = link.attach({ browser: 'Chrome B', extension: '4.0.6', methods }).linkId;
  await link.next({ linkId: b, waitMs: 1000 });
  // Which of them a call is handed to, answered there.
  const goes = async (capability, input) => {
    const asked = link.call({ capability, input }, { readOnly: capability === 'chrome.tabs.list' });
    const answers = await Promise.all([link.next({ linkId: a, waitMs: 60 }), link.next({ linkId: b, waitMs: 60 })]), at = answers.findIndex(answer => answer.calls.length);
    link.result({ linkId: [a, b][at], id: answers[at].calls[0].id, ok: true, result: { items: [] } });
    await asked;
    return 'AB'[at];
  };
  const refused = () => assert.rejects(link.call({ capability: 'chrome.tabs.close', input: { tabIds: [57] } }), { code: 'browser_changed', notStarted: true });
  assert.equal(await goes('chrome.tabs.list', {}), 'B');
  assert.equal(await goes('chrome.tabs.close', { tabIds: [57] }), 'B', 'the browser that answered is the one asked');
  // B is paused: what names an id is not handed to A; a look that names nothing is, and from then on A's ids are the ones known.
  link.state({ linkId: b, paused: true });
  await refused();
  assert.equal(await goes('chrome.tabs.list', {}), 'A');
  assert.equal(await goes('chrome.tabs.close', { tabIds: [57] }), 'A');
  // The owner chooses B again ("use this browser" lifts no pause, so the pause is lifted as well).
  link.state({ linkId: b, paused: false }); link.prefer({ linkId: b });
  await refused();
  assert.equal(await goes('chrome.tabs.list', {}), 'B');
  // A third browser connects and is the one used from then on.
  const c = link.attach({ browser: 'Chrome C', extension: '4.0.6', methods }).linkId;
  await link.next({ linkId: c, waitMs: 1000 });
  await refused();
  link.close();
});

test('where several browsers are connected the owner says which one is used: a paused one is passed over, and one chosen in its panel is used', async () => {
  // Every call went to the browser that connected last. One the owner had paused refused them all while another
  // stood idle, and nothing said which of two browsers was the one in use, nor let the owner choose.
  const link = createBrowserLink({ callTimeoutMs: 2000 }), methods = ['tabs.list'];
  // (Told in the moment, not when its wait for work is over: a host waits for twenty-five seconds.)
  const soon = answer => Promise.race([answer, new Promise((resolve, reject) => setTimeout(() => reject(new Error('the host that waited was not told')), 1000))]);
  const a = link.attach({ browser: 'Chrome A', extension: '4.0.6', methods }).linkId;
  // A browser is told how it stands with its first answer, at once: here the only one, and the one that is used.
  assert.deepEqual(await link.next({ linkId: a, waitMs: 5000 }), { calls: [], current: true, browsers: 1 });
  // A second one connects. From its first question on it is the one that is used, and the first, which was
  // waiting for work, is told so in that moment.
  let waiting = link.next({ linkId: a, waitMs: 5000 });
  const b = link.attach({ browser: 'Chrome B', extension: '4.0.6', methods }).linkId;
  assert.deepEqual(await link.next({ linkId: b, waitMs: 5000 }), { calls: [], current: true, browsers: 2 });
  assert.deepEqual(await soon(waiting), { calls: [], current: false, browsers: 2 });
  assert.deepEqual(link.status().connections.map(one => [one.browser, one.current, one.paused]), [['Chrome B', true, undefined], ['Chrome A', undefined, undefined]]);
  // Which of the two a call is handed to.
  const goes = async () => {
    const asked = link.call({ capability: 'chrome.tabs.list' }, { readOnly: true });
    const answers = await Promise.all([link.next({ linkId: a, waitMs: 60 }), link.next({ linkId: b, waitMs: 60 })]), at = answers.findIndex(answer => answer.calls.length);
    link.result({ linkId: [a, b][at], id: answers[at].calls[0].id, ok: true, result: { items: [] } });
    await asked;
    return 'AB'[at];
  };
  assert.equal(await goes(), 'B');
  // The owner pauses B in its panel: A is used, and is told so while it waits.
  waiting = link.next({ linkId: a, waitMs: 5000 });
  assert.deepEqual(link.state({ linkId: b, paused: true }), { current: false, browsers: 2 });
  assert.deepEqual(await soon(waiting), { calls: [], current: true, browsers: 2 });
  assert.equal(await goes(), 'A');
  assert.deepEqual(link.status().connections.map(one => [one.browser, one.current, one.paused]), [['Chrome A', true, undefined], ['Chrome B', undefined, true]]);
  // B may be used again: it is, being the one that connected last.
  link.state({ linkId: b, paused: false });
  assert.equal(await goes(), 'B');
  // "Use this browser" in the panel of A: A is used from now on, though B connected after it.
  assert.deepEqual(link.prefer({ linkId: a }), { current: true, browsers: 2 });
  assert.equal(await goes(), 'A'); assert.equal(link.status().browser, 'Chrome A');
  // Choosing a browser does not take its pause away: the other one is used, and the answer says so.
  link.state({ linkId: a, paused: true });
  assert.deepEqual(link.prefer({ linkId: a }), { current: false, browsers: 2 });
  assert.equal(await goes(), 'B');
  // Every browser paused: one of them is asked all the same, and what is said of it is that it is paused.
  link.state({ linkId: b, paused: true });
  assert.equal(link.status().paused, true);
  // Only a link that is there speaks, and only of itself.
  assert.throws(() => link.prefer({ linkId: 'browser-of-nobody' }), { code: 'not_found' });
  assert.throws(() => link.state({ linkId: 'browser-of-nobody', paused: false }), { code: 'not_found' });
  // A look that waited on a browser which then went away goes to another one, as before: to one that is not
  // paused, where there is one, though a paused one connected after it.
  link.state({ linkId: a, paused: false });
  link.prefer({ linkId: b });
  const c = link.attach({ browser: 'Chrome C', extension: '4.0.6', methods }).linkId;
  await link.next({ linkId: c, waitMs: 5000 });
  const looked = link.call({ capability: 'chrome.tabs.list' }, { readOnly: true });
  link.detach({ linkId: c });
  const [toA, toB] = await Promise.all([link.next({ linkId: a, waitMs: 80 }), link.next({ linkId: b, waitMs: 80 })]);
  assert.deepEqual([toA.calls.length, toB.calls.length], [1, 0], 'the paused browser is not asked while another one is free');
  link.result({ linkId: a, id: toA.calls[0].id, ok: true, result: { items: [] } });
  await looked;
  // One of the two goes: the other is told that it is alone in that moment, and nothing is listed any more.
  waiting = link.next({ linkId: a, waitMs: 5000 });
  link.detach({ linkId: b });
  assert.deepEqual(await soon(waiting), { calls: [], current: true, browsers: 1 });
  assert.equal(link.status().connections, undefined);
  link.close();
});

test('the browser host carries the owner\'s word between a browser\'s panel and the runtime: paused, which browser is used, and "use this browser"', async () => {
  const input = new PassThrough(), output = new PassThrough(), heard = [], asked = [];
  output.on('data', frames(message => heard.push(message)));
  let standing = { current: true, browsers: 1 };
  const client = { status: async () => ({ running: true, record: { version: '4.0.6', port: 8788 } }),
    call: async (name, args) => {
      asked.push([name, args]);
      if (name === 'chrome.attach') return { linkId: 'link' };
      if (name === 'chrome.next') return new Promise(resolve => setTimeout(() => resolve({ calls: [], ...standing }), 30));
      if (name === 'chrome.state') return standing = { current: !args.paused, browsers: 2 };
      if (name === 'chrome.prefer') return standing = { current: true, browsers: 2 };
      return { items: [] };
    } };
  const served = serveChromeHost({ origin: EXTENSION_ORIGIN, input, output, client, pollMs: 20 });
  const stood = () => heard.filter(message => message.name === 'link.status').map(message => message.data);
  // What the owner chose in the panel is said with the first word, where the extension knows it by then.
  input.write(frame({ type: 'hello', protocol: 1, extension: '4.0.6', browser: 'Google Chrome', methods: [], paused: true }));
  await until(() => stood().length === 1, 'how this browser stands');
  assert.deepEqual(asked.find(([name]) => name === 'chrome.attach')[1], { browser: 'Google Chrome', extension: '4.0.6', methods: [], paused: true });
  assert.deepEqual(stood(), [{ current: true, browsers: 1 }]);
  // What has not changed is not said again.
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(stood().length, 1);
  // The owner lets DevMate use the browser again: the runtime is told, and the panel hears how it stands now.
  input.write(frame({ type: 'state', paused: false }));
  await until(() => stood().length === 2, 'the news after the pause was lifted');
  assert.deepEqual(asked.find(([name]) => name === 'chrome.state')[1], { linkId: 'link', paused: false });
  assert.deepEqual(stood().at(-1), { current: true, browsers: 2 });
  // Another browser took over meanwhile, and the owner chooses this one in its panel.
  standing = { current: false, browsers: 2 };
  await until(() => stood().at(-1).current === false, 'the news that another browser is used');
  input.write(frame({ type: 'request', id: 'r1', action: 'prefer' }));
  await until(() => heard.some(message => message.type === 'response' && message.id === 'r1'), 'the answer to the choice');
  assert.deepEqual(heard.find(message => message.id === 'r1'), { type: 'response', id: 'r1', ok: true, result: { current: true, browsers: 2 } });
  assert.deepEqual(asked.find(([name]) => name === 'chrome.prefer')[1], { linkId: 'link' });
  assert.deepEqual(stood().at(-1), { current: true, browsers: 2 });
  // A word that is no yes or no is not passed on.
  const states = asked.filter(([name]) => name === 'chrome.state').length;
  input.write(frame({ type: 'state', paused: 'yes' }));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(asked.filter(([name]) => name === 'chrome.state').length, states);
  input.end(); await served;
});

test('the browser host passes on a pause the owner chose while the link was being made, and says it again until the runtime has it', async () => {
  // The browser starts with the owner's pause already set: the first hello does not know it yet, and the extension
  // says it while the link is being made. It was kept for a link that was not there, and never said: the runtime held
  // a paused browser for one that is not, and asked it every time.
  const input = new PassThrough(), output = new PassThrough(), asked = [];
  let attached = null, refusals = 1;
  const client = { status: async () => ({ running: true, record: { version: '4.0.6', port: 8788 } }),
    call: async (name, args) => {
      asked.push([name, args]);
      if (name === 'chrome.attach') return new Promise(resolve => { attached = () => resolve({ linkId: 'link' }); });
      if (name === 'chrome.next') return new Promise(resolve => setTimeout(() => resolve({ calls: [], current: true, browsers: 1 }), 20));
      if (name === 'chrome.state') { if (refusals-- > 0) throw Object.assign(new Error('The runtime did not answer in time.'), { code: 'RUNTIME_TIMEOUT' }); return { current: !args.paused, browsers: 2 }; }
      return { items: [] };
    } };
  const served = serveChromeHost({ origin: EXTENSION_ORIGIN, input, output, client, pollMs: 20 });
  const states = () => asked.filter(([name]) => name === 'chrome.state').map(([, args]) => args.paused);
  input.write(frame({ type: 'hello', protocol: 1, extension: '4.0.6', browser: 'Google Chrome', methods: [] }));
  await until(() => attached, 'the link to be asked for');
  input.write(frame({ type: 'state', paused: true }));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(states(), [], 'nothing is said of a link that is not there yet');
  assert.equal(asked.find(([name]) => name === 'chrome.attach')[1].paused, undefined);
  attached();
  // Said once the link is there. The runtime does not take it the first time: that is no "said", and it is said again.
  await until(() => states().length === 2, 'the pause to be said again');
  assert.deepEqual(states(), [true, true]);
  // Once the runtime has it, it is not said again.
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(states().length, 2);
  input.end(); await served;
});

test('a browser host whose own program was replaced by an update leaves, so that the browser starts the new one', async () => {
  // A host is started once and lives as long as the browser. After an update of DevMate it went on speaking for a
  // program that is not installed any more, until somebody ended it by hand.
  const input = new PassThrough(), output = new PassThrough(), heard = [], asked = [];
  output.on('data', frames(message => heard.push(message)));
  const client = { status: async () => ({ running: true, record: { version: '4.0.6', port: 8788 } }),
    call: async name => { asked.push(name); return name === 'chrome.attach' ? { linkId: 'link' } : name === 'chrome.next' ? new Promise(resolve => setTimeout(() => resolve({ calls: [] }), 40)) : { items: [] }; } };
  let replaced = false, ended = false;
  const served = serveChromeHost({ origin: EXTENSION_ORIGIN, input, output, client, pollMs: 20, replaced: () => replaced }).then(() => { ended = true; });
  input.write(frame({ type: 'hello', protocol: 1, extension: '4.0.6', browser: 'Google Chrome', methods: [] }));
  await until(() => asked.includes('chrome.next'), 'the link');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(ended, false, 'it serves for as long as its program is the one that was started');
  replaced = true;
  await served;
  assert.ok(asked.includes('chrome.detach'), 'the runtime is told that this link is over');
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
  // Nor is a command that a connected client started (its shell tool, or an agent it delegated to), whatever
  // extension it names: what the host is answered is the owner's. A browser that such a command opened carries the
  // mark too, with every host it starts, and that may be the owner's own browser: so the host says why, in the one
  // message the extension shows as it is, where the browser would only say that the host has ended. It answers
  // nothing that is asked of it (a sign-in link to the workbench least of all), and ends.
  const theirs = spawn(process.execPath, [program, 'chrome-host', EXTENSION_ORIGIN, '--parent-window=0', '--instance', instanceRoot], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEVMATE_CLIENT_COMMAND: '1' } });
  const theirsHeard = []; let theirsSaid = ''; theirs.stdout.on('data', frames(message => theirsHeard.push(message))); theirs.stderr.on('data', chunk => { theirsSaid += chunk; });
  theirs.stdin.on('error', () => {});
  theirs.stdin.write(frame({ type: 'hello', protocol: 1, extension: '4.0.5', browser: 'Google Chrome', methods: [] }));
  theirs.stdin.end(frame({ type: 'request', id: 1, action: 'workbench' }));
  assert.equal(await new Promise(resolve => theirs.once('close', resolve)), 2);
  assert.deepEqual(theirsHeard, [{ type: 'refused', message: 'DevMate does not serve this browser: it was opened by a command that a connected client or a coding agent ran, and carries that command\'s mark, so what it asks is not taken as yours. ' +
    'Close the browser completely (every window, and its icon beside the clock if it keeps one) and open it yourself: the extension then connects again.' }]);
  assert.ok(theirsHeard[0].message.length <= 600, 'the extension shows it whole');
  assert.equal(theirsSaid, 'devmate chrome-host is started by the browser for the DevMate extension, not through a connected client\n');

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
  assert.deepEqual([ready.protocol, ready.runtime.running, ready.runtime.port], [1, false, undefined]);
  assert.deepEqual((await ask('status')).result.running, false);
  assert.equal((await ask('stop')).error.code, 'invalid_input'); assert.equal((await ask('pending')).error.code, 'not_running');
  // A runtime comes up (here in this process, as an editor or the command line would start it): the extension is told.
  runtime = await startRuntime({ instanceRoot, port: 0, connectionFactory: () => ({ async start() {}, async stop() {}, status() { return { kind: 'local', status: 'ready' }; } }) });
  const told = await hear(message => message.type === 'event' && message.name === 'runtime.status' && message.data.running === true, 'the news that the runtime runs');
  assert.match(told.data.version, /^\d+\.\d+\.\d+/);
  // With it, the local port the runtime answers the owner on: the extension keeps the browser's tools off that origin.
  assert.equal(told.data.port, runtime.port); assert.equal((await ask('status')).result.port, runtime.port);
  await until(() => runtime.service.browser.status().connected, 'the browser to be linked');
  assert.deepEqual([runtime.service.browser.status().browser, runtime.service.browser.status().extension], ['Google Chrome', '4.0.5']);
  // As an entry: the status, the workbench, the MCP address, what waits; and a start that joins what already runs.
  assert.equal((await ask('start')).result.running, true);
  assert.match((await ask('workbench')).result.url, /^http:\/\/127\.0\.0\.1:\d+\/\?code=/); const address = (await ask('mcpUrl')).result;
  // No public route is configured here: the address is this computer's own, and says so.
  assert.match(address.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/); assert.equal(address.scope, 'local');
  assert.deepEqual((await ask('pending')).result, { count: 0 });
  // What waits for the owner is told as a number. What it says, a task a client handed over among it, is not sent
  // into the browser.
  const waits = runtime.service.store.create('approval', { status: 'pending', kind: 'delegation', summary: 'A connected client asks codex to run a task: the-words-of-the-task' });
  const counted = await ask('pending');
  assert.deepEqual(counted.result, { count: 1 }); assert.ok(!JSON.stringify(counted).includes('the-words-of-the-task'));
  // The number is the number: twenty tasks of a client may wait at once, beside what agents ask in their own tasks.
  const many = Array.from({ length: 24 }, (_, index) => runtime.service.store.create('approval', { status: 'pending', summary: 'Request ' + index }));
  const asks = Array.from({ length: 5 }, (_, index) => runtime.service.store.create('input', { status: 'pending', summary: 'Question ' + index }));
  assert.deepEqual((await ask('pending')).result, { count: 30 });
  for (const item of [waits, ...many]) runtime.service.store.update('approval', item.id, { status: 'resolved' });
  for (const item of asks) runtime.service.store.update('input', item.id, { status: 'resolved' });

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
  for (const [operation, input] of [['chrome.attach', { methods: [] }], ['chrome.next', { linkId: 'x' }], ['chrome.result', { linkId: 'x', id: 'y', ok: true }], ['chrome.detach', { linkId: 'x' }],
    ['chrome.state', { linkId: 'x', paused: false }], ['chrome.prefer', { linkId: 'x' }]])
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

// After a restart the owner's choice is forgotten and whichever browser came back last is used: a model may still
// hold ids from before. While several browsers are connected and none has answered since, an id is nobody's yet.
test('with several browsers connected and none answered yet, a call that names an id is not passed on; alone, a browser is the one', async () => {
  const link = createBrowserLink({ callTimeoutMs: 2000 }), methods = ['tabs.list', 'tabs.close'];
  const serve = linkId => { void (async () => { for (;;) { let work; try { work = await link.next({ linkId, waitMs: 300 }); } catch { return; }
    for (const call of work.calls) link.result({ linkId, id: call.id, ok: true, result: { by: linkId } }); } })(); };
  const first = link.attach({ browser: 'Google Chrome', extension: '4.0.6', methods }).linkId; serve(first);
  // Alone: its ids are its own, answered or not.
  const lone = createBrowserLink({ callTimeoutMs: 2000 }), only = lone.attach({ browser: 'Google Chrome', extension: '4.0.6', methods }).linkId;
  const closing = lone.call({ capability: 'chrome.tabs.close', input: { tabIds: [5] } }), given = await lone.next({ linkId: only, waitMs: 1000 });
  lone.result({ linkId: only, id: given.calls[0].id, ok: true, result: { closed: [5] } });
  assert.deepEqual(await closing, { closed: [5] });
  lone.close();
  // Two, and nothing answered yet: refused before anything is asked, with what to do.
  const second = link.attach({ browser: 'Microsoft Edge', extension: '4.0.6', methods }).linkId; serve(second);
  await new Promise(resolve => setTimeout(resolve, 100));
  const refused = await link.call({ capability: 'chrome.tabs.close', input: { tabIds: [5] } }).then(() => null, failure => failure);
  assert.deepEqual([refused?.code, refused?.notStarted], ['browser_changed', true]);
  assert.match(refused.message, /^Several browsers are connected and none has answered a call since DevMate started/);
  assert.match(refused.message, /Ask the browser that is used now what it has \(tabs\.list, bookmarks\.tree\), then call again\.$/);
  // A look that names nothing is answered, and from then on the ids are those of the browser that answered it.
  const answeredBy = (await link.call({ capability: 'chrome.tabs.list' }, { readOnly: true })).by;
  assert.equal(answeredBy, second);
  assert.deepEqual(await link.call({ capability: 'chrome.tabs.close', input: { tabIds: [5] } }), { by: second });
  link.close();
});

test('a browser that is lost or comes back wakes the other hosts only where that changes which browser is used', async () => {
  const link = createBrowserLink({ idleMs: 5000, unheardMs: 5000, callTimeoutMs: 2000 }), methods = ['tabs.list'];
  const attach = name => link.attach({ browser: name, extension: '4.0.6', methods }).linkId;
  const a = attach('A'), b = attach('B'), c = attach('C');
  for (const id of [a, b, c]) await link.next({ linkId: id, waitMs: 1 });
  // C came last and is used. A waits for work; B, which is not used, is lost: nothing changes for A.
  const started = Date.now(), waiting = link.next({ linkId: a, waitMs: 600 });
  const away = new AbortController(), asking = link.next({ linkId: b, waitMs: 5000 }, { signal: away.signal });
  away.abort(); await asking;
  const told = await waiting;
  assert.ok(Date.now() - started >= 550, 'A was answered after ' + (Date.now() - started) + ' ms, not woken');
  assert.deepEqual([told.current, told.browsers], [false, 3]);
  // C, which is used, is lost: A is not used either, B is lost, so the choice falls to A, and A is woken at once.
  const second = Date.now(), again = link.next({ linkId: a, waitMs: 3000 });
  const gone = new AbortController(), last = link.next({ linkId: c, waitMs: 5000 }, { signal: gone.signal });
  gone.abort(); await last;
  const now = await again;
  assert.ok(Date.now() - second < 1000, 'A was woken after ' + (Date.now() - second) + ' ms');
  assert.equal(now.current, true);
  link.close();
});
