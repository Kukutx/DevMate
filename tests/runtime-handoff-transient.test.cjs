'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { waitForStaleGatewayHandoff } = require('../host/runtime/process-controller.js');

const config = { instanceId: 'handoff-instance', appVersion: '3.8.7', server: { port: 8787 } };
const unavailable = { ok: false, error: 'ECONNRESET' };

function health(overrides = {}) {
  return { ok: true, json: { name: 'devmate', instanceId: config.instanceId, version: '3.8.6', port: 8787, ...overrides } };
}

function handoffScenario(healthResponses, portResponses = [false], initialHealth = health()) {
  const state = { elapsed: 0, probes: [], portChecks: 0, pauses: [] };
  const options = {
    initialHealth,
    clock: () => state.elapsed,
    probeHealth: async (port, timeoutMs) => {
      assert.equal(port, config.server.port);
      const response = healthResponses[Math.min(state.probes.length, healthResponses.length - 1)];
      state.probes.push(timeoutMs);
      return response;
    },
    probePortFree: async port => {
      assert.equal(port, config.server.port);
      return portResponses[Math.min(state.portChecks++, portResponses.length - 1)];
    },
    wait: async ms => {
      state.pauses.push(ms);
      state.elapsed += ms;
    }
  };
  return { state, options };
}

test('confirmed Gateway handoff tolerates a health reset until the current version answers', async () => {
  const ready = health({ version: config.appVersion });
  const { state, options } = handoffScenario([unavailable, ready]);
  assert.deepEqual(await waitForStaleGatewayHandoff(config, 8787, 250, options), {
    attached: true, released: false, health: ready.json
  });
  assert.equal(state.portChecks, 1);
  assert.deepEqual(state.pauses, [100]);
});

test('a same-instance health probe establishes the bounded handoff window', async () => {
  const ready = health({ version: config.appVersion });
  const { state, options } = handoffScenario([health(), unavailable, ready], [false], null);
  const result = await waitForStaleGatewayHandoff(config, 8787, 250, options);
  assert.equal(result.attached, true);
  assert.deepEqual(state.pauses, [100, 100]);
});

test('confirmed Gateway handoff waits through an occupied port until it is released', async () => {
  const { state, options } = handoffScenario([unavailable], [false, true]);
  assert.deepEqual(await waitForStaleGatewayHandoff(config, 8787, 250, options), {
    attached: false, released: true, health: null
  });
  assert.equal(state.portChecks, 2);
  assert.deepEqual(state.pauses, [100]);
});

test('Gateway handoff rejects a healthy different instance without waiting or probing its port', async () => {
  const foreign = health({ instanceId: 'another-instance' });
  const { state, options } = handoffScenario([foreign]);
  await assert.rejects(waitForStaleGatewayHandoff(config, 8787, 250, options), {
    code: 'DEVMATE_GATEWAY_PORT_CONFLICT', sameInstance: false
  });
  assert.equal(state.portChecks, 0);
  assert.deepEqual(state.pauses, []);
});

test('an unknown occupied port cannot enter the Gateway handoff grace period', async () => {
  for (const initialHealth of [null, health({ instanceId: 'another-instance' })]) {
    const { state, options } = handoffScenario([unavailable], [false], initialHealth);
    await assert.rejects(waitForStaleGatewayHandoff(config, 8787, 250, options), {
      code: 'DEVMATE_GATEWAY_PORT_CONFLICT'
    });
    assert.equal(state.portChecks, 1);
    assert.deepEqual(state.pauses, []);
  }
});

test('Gateway handoff bounds repeated missing health probes and pauses to one deadline', async () => {
  const { state, options } = handoffScenario([unavailable]);
  await assert.rejects(waitForStaleGatewayHandoff(config, 8787, 250, options), {
    code: 'DEVMATE_GATEWAY_PORT_CONFLICT'
  });
  assert.deepEqual(state.probes, [250, 150, 50]);
  assert.deepEqual(state.pauses, [100, 100, 50]);
  assert.equal(state.elapsed, 250);
});

test('Gateway handoff does not restart an exhausted startup budget', async () => {
  const { state, options } = handoffScenario([unavailable]);
  await assert.rejects(waitForStaleGatewayHandoff(config, 8787, 0, options), {
    code: 'DEVMATE_GATEWAY_STALE_INSTANCE'
  });
  assert.deepEqual(state.probes, []);
  assert.equal(state.portChecks, 0);
  assert.deepEqual(state.pauses, []);
});

test('Gateway handoff rejects a matching health response that arrives after its deadline', async () => {
  const { state, options } = handoffScenario([]);
  options.probeHealth = async () => {
    state.elapsed = 250;
    return health({ version: config.appVersion });
  };
  await assert.rejects(waitForStaleGatewayHandoff(config, 8787, 250, options), {
    code: 'DEVMATE_GATEWAY_STALE_INSTANCE'
  });
  assert.equal(state.portChecks, 0);
});

test('Gateway handoff rejects a port-release result that arrives after its deadline', async () => {
  const { state, options } = handoffScenario([unavailable]);
  options.probePortFree = async () => {
    state.elapsed = 250;
    return true;
  };
  await assert.rejects(waitForStaleGatewayHandoff(config, 8787, 250, options), {
    code: 'DEVMATE_GATEWAY_PORT_CONFLICT'
  });
  assert.deepEqual(state.pauses, []);
});

test('Gateway handoff deadline interrupts an unresponsive health probe', { timeout: 2000 }, async () => {
  await assert.rejects(waitForStaleGatewayHandoff(config, 8787, 25, {
    initialHealth: health(),
    probeHealth: async () => new Promise(() => {}),
    probePortFree: async () => { assert.fail('port probe must not run after timeout'); }
  }), { code: 'DEVMATE_GATEWAY_STALE_INSTANCE' });
});

test('Gateway handoff deadline interrupts an unresponsive port probe', { timeout: 2000 }, async () => {
  await assert.rejects(waitForStaleGatewayHandoff(config, 8787, 25, {
    initialHealth: health(),
    probeHealth: async () => unavailable,
    probePortFree: async () => new Promise(() => {})
  }), { code: 'DEVMATE_GATEWAY_PORT_CONFLICT' });
});
