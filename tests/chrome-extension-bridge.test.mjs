import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, HOST, PROTOCOL, createBridge } from '../chrome-extension/bridge.js';

// A native messaging port as the bridge sees it: what was posted, and a way to deliver what the host says.
function fakePort() {
  const posted = [], listeners = { message: [], disconnect: [] };
  return { posted,
    port: { postMessage: message => posted.push(message), onMessage: { addListener: listener => listeners.message.push(listener) }, onDisconnect: { addListener: listener => listeners.disconnect.push(listener) } },
    say: async message => { for (const listener of listeners.message) listener(message); await new Promise(resolve => setImmediate(resolve)); },
    drop: reason => { for (const listener of listeners.disconnect) listener(reason); } };
}
function harness({ startWithBrowser = false, paused = false, methods = { 'browser.info': async () => ({ ok: 1 }) } } = {}) {
  const ports = [], timers = [], states = [], saved = { startWithBrowser, paused };
  const bridge = createBridge({ connect: name => { const link = fakePort(); link.name = name; ports.push(link); return link.port; }, methods, version: '9.9.9', browser: 'Test',
    settings: { get: async () => ({ ...saved }), set: async values => { Object.assign(saved, values); } }, onChange: state => states.push(state), clock: () => 1000,
    schedule: (run, ms) => { const timer = { run, ms, cancelled: false }; timers.push(timer); return timer; }, cancel: timer => { if (timer) timer.cancelled = true; } });
  return { bridge, ports, timers, states };
}

test('opening connects to DevMate\'s host and says what this extension can do', () => {
  const { bridge, ports } = harness();
  bridge.open();
  assert.equal(ports.length, 1);
  assert.equal(ports[0].name, HOST);
  assert.deepEqual(ports[0].posted[0], { type: 'hello', protocol: PROTOCOL, extension: '9.9.9', browser: 'Test', methods: ['browser.info'] });
  assert.equal(bridge.state().host, 'connecting');
  bridge.open();
  assert.equal(ports.length, 1, 'a second open does not connect twice');
});

test('ready makes it connected, and a runtime that is not running is left alone while the switch is off', async () => {
  const { bridge, ports } = harness();
  bridge.open();
  await ports[0].say({ type: 'ready', protocol: 1, runtime: { running: false, version: '4.0.5' } });
  assert.equal(bridge.connected(), true);
  assert.deepEqual(bridge.state().runtime, { running: false, version: '4.0.5' });
  assert.equal(ports[0].posted.some(message => message.action === 'start'), false);
});

test('with "start with the browser" on, a runtime that is not running is started', async () => {
  const { bridge, ports } = harness({ startWithBrowser: true });
  bridge.open();
  await ports[0].say({ type: 'ready', protocol: 1, runtime: { running: false } });
  const asked = ports[0].posted.find(message => message.type === 'request');
  assert.equal(asked.action, 'start');
  await ports[0].say({ type: 'response', id: asked.id, ok: true, result: { running: true, version: '4.0.5' } });
  assert.deepEqual(bridge.state().runtime, { running: true, version: '4.0.5' });
});

test('a runtime that already runs is never started again, and what waits for the owner is asked for', async () => {
  const { bridge, ports } = harness({ startWithBrowser: true });
  bridge.open();
  await ports[0].say({ type: 'ready', protocol: 1, runtime: { running: true } });
  const asked = ports[0].posted.filter(message => message.type === 'request');
  assert.deepEqual(asked.map(message => message.action), ['pending']);
  await ports[0].say({ type: 'response', id: asked[0].id, ok: true, result: { count: 3 } });
  assert.equal(bridge.state().pending, 3);
});

test('a call from the runtime is run and answered under its id; an unknown method is refused, not run', async () => {
  const seen = [];
  const { bridge, ports } = harness({ methods: { 'tabs.list': async params => { seen.push(params); return { items: [] }; } } });
  bridge.open();
  await ports[0].say({ type: 'call', id: 'c1', method: 'tabs.list', params: { query: 'x' } });
  await ports[0].say({ type: 'call', id: 'c2', method: 'tabs.vanish', params: {} });
  assert.deepEqual(seen, [{ query: 'x' }]);
  assert.deepEqual(ports[0].posted.find(message => message.id === 'c1'), { type: 'result', id: 'c1', ok: true, result: { items: [] } });
  const refused = ports[0].posted.find(message => message.id === 'c2');
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'not_supported');
});

test('as an entry it asks for five things and nothing else', async () => {
  const { bridge, ports } = harness();
  bridge.open();
  await ports[0].say({ type: 'ready', protocol: 1, runtime: { running: true } });
  assert.deepEqual([...ACTIONS], ['status', 'start', 'workbench', 'mcpUrl', 'pending']);
  await assert.rejects(bridge.request('stop'), error => error.code === 'invalid_input');
  await assert.rejects(bridge.request('operations.call'), error => error.code === 'invalid_input');
  assert.equal(ports[0].posted.some(message => message.action === 'stop'), false);
});

test('a refusal from DevMate reaches the caller with its code, and no answer in time is a timeout', async () => {
  const { bridge, ports, timers } = harness();
  bridge.open();
  await ports[0].say({ type: 'ready', protocol: 1, runtime: { running: true } });
  const refused = assert.rejects(bridge.request('workbench'), error => error.code === 'forbidden' && error.message === 'No.');
  const asked = ports[0].posted.findLast(message => message.type === 'request');
  await ports[0].say({ type: 'response', id: asked.id, ok: false, error: { code: 'forbidden', message: 'No.' } });
  await refused;
  const silent = assert.rejects(bridge.request('mcpUrl'), error => error.code === 'timeout');
  timers.findLast(timer => !timer.cancelled).run();
  await silent;
});

test('before it is connected, a request fails at once instead of waiting', async () => {
  const { bridge } = harness();
  await assert.rejects(bridge.request('status'), error => error.code === 'not_connected');
});

test('a host that is not registered is named as that, with the command that registers it; a dropped connection is tried again', async () => {
  const { bridge, ports, timers } = harness();
  bridge.open();
  ports[0].drop('Specified native messaging host not found.');
  assert.equal(bridge.state().host, 'missing');
  assert.equal(bridge.state().said, 'Specified native messaging host not found.', 'the browser\'s own words are kept as they are');
  assert.equal(bridge.state().attempts, 1);
  const again = timers.findLast(timer => !timer.cancelled);
  assert.equal(again.ms, 30000);
  again.run();
  assert.equal(ports.length, 2, 'it connects again');
  await ports[1].say({ type: 'ready', protocol: 1, runtime: { running: true } });
  const waiting = assert.rejects(bridge.request('status'), error => error.code === 'not_connected');
  ports[1].drop('');
  await waiting;
  assert.equal(bridge.state().host, 'closed');
  assert.equal(bridge.state().runtime, null);
});

test('events keep the state current: the runtime, what waits for the owner', async () => {
  const { bridge, ports, states } = harness();
  bridge.open();
  await ports[0].say({ type: 'ready', protocol: 1, runtime: { running: true, version: '4.0.5' } });
  await ports[0].say({ type: 'event', name: 'pending.changed', data: { count: 2 } });
  assert.equal(bridge.state().pending, 2);
  await ports[0].say({ type: 'event', name: 'approval.created', data: {} });
  assert.equal(bridge.state().pending, 3);
  await ports[0].say({ type: 'event', name: 'runtime.status', data: { running: false } });
  assert.deepEqual(bridge.state().runtime, { running: false });
  assert.ok(states.length >= 4, 'every change is announced');
});

test('"Access … is forbidden" is the same case as a host that is not registered, and the owner can try again at once', async () => {
  const { bridge, ports, timers } = harness();
  bridge.open();
  ports[0].drop('Access to the specified native messaging host is forbidden.');
  assert.equal(bridge.state().host, 'missing');
  bridge.again();
  assert.equal(ports.length, 2, 'another try does not wait for the half minute');
  assert.equal(timers.filter(timer => !timer.cancelled).length, 0, 'and the waiting one is called off');
  bridge.again();
  assert.equal(ports.length, 2, 'while a try is under way, asking again starts no second one');
});

test('a host that ends for another reason is a lost connection, not a missing registration', () => {
  const { bridge, ports } = harness();
  bridge.open();
  ports[0].drop('Native host has exited.');
  assert.equal(bridge.state().host, 'closed');
  assert.equal(bridge.state().said, 'Native host has exited.');
});

test('a host that says why it will not serve this browser is shown in its own words, and asked again every half minute', async () => {
  // A browser that was opened by a command a connected client started carries that command's mark, and the host
  // does not serve it. The browser itself would only say that the host has ended.
  const { bridge, ports, timers } = harness();
  bridge.open();
  const why = 'DevMate does not serve this browser: it was opened by a command of a connected client. Close the browser completely and open it yourself.';
  await ports[0].say({ type: 'refused', message: why });
  assert.equal(bridge.state().host, 'connecting', 'the words alone end nothing');
  ports[0].drop('Native host has exited.');
  assert.equal(bridge.state().host, 'closed');
  assert.equal(bridge.state().said, why);
  assert.equal(timers.findLast(timer => !timer.cancelled).ms, 30000, 'what it named does not change by trying fast');
  // The words are for that one connection: the next one that ends says what the browser says of it.
  timers.findLast(timer => !timer.cancelled).run();
  ports[1].drop('Native host has exited.');
  assert.equal(bridge.state().said, 'Native host has exited.');
  // Words that are no text, or far too many, are not shown as they come.
  timers.findLast(timer => !timer.cancelled).run();
  await ports[2].say({ type: 'refused', message: 'x'.repeat(5000) });
  ports[2].drop('');
  assert.equal(bridge.state().said.length, 600);
  timers.findLast(timer => !timer.cancelled).run();
  await ports[3].say({ type: 'refused' });
  ports[3].drop('');
  assert.equal(bridge.state().said, 'The connection to DevMate was closed.');
});
test('every call is noted without what it carried: what, when, whether it worked', async () => {
  const { bridge, ports } = harness({ methods: { 'tabs.list': async () => ({ items: [] }), 'tabs.close': async () => { throw Object.assign(new Error('No tab.'), { code: 'not_found' }); } } });
  bridge.open();
  await ports[0].say({ type: 'call', id: 'a', method: 'tabs.list', params: { query: 'secret words' } });
  await ports[0].say({ type: 'call', id: 'b', method: 'tabs.close', params: { tabIds: [1] } });
  const { activity, calls } = bridge.state();
  assert.equal(calls, 2);
  assert.deepEqual(activity.map(entry => [entry.method, entry.read, entry.ok, entry.code]), [['tabs.close', false, false, 'not_found'], ['tabs.list', true, true, undefined]]);
  assert.equal(JSON.stringify(activity).includes('secret words'), false);
});

test('paused, nothing is run: the runtime is told so, and the refusal is noted', async () => {
  const ran = [];
  const { bridge, ports } = harness({ methods: { 'bookmarks.remove': async () => { ran.push(1); return {}; } } });
  bridge.open();
  await bridge.pause(true);
  await ports[0].say({ type: 'call', id: 'p1', method: 'bookmarks.remove', params: { id: '5' } });
  assert.deepEqual(ran, []);
  const refused = ports[0].posted.find(message => message.id === 'p1');
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'paused');
  assert.equal(bridge.state().paused, true);
  await bridge.pause(false);
  await ports[0].say({ type: 'call', id: 'p2', method: 'bookmarks.remove', params: { id: '5' } });
  assert.deepEqual(ran, [1]);
});
