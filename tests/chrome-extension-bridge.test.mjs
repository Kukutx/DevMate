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
function harness({ startWithBrowser = false, methods = { 'browser.info': async () => ({ ok: 1 }) } } = {}) {
  const ports = [], timers = [], states = [];
  const bridge = createBridge({ connect: name => { const link = fakePort(); link.name = name; ports.push(link); return link.port; }, methods, version: '9.9.9', browser: 'Test',
    settings: { get: async () => ({ startWithBrowser }) }, onChange: state => states.push(state),
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
  assert.match(bridge.state().problem, /devmate chrome install/);
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
