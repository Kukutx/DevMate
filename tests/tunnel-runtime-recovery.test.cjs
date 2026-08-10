'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ATTACHMENT_POLL_MS,
  clearTunnelController,
  setTunnelController,
  startTunnel,
  stopTunnel
} = require('../vscode-host/tunnel-runtime.js');

function waitFor(predicate, timeoutMs = ATTACHMENT_POLL_MS + 1500) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for tunnel recovery'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

test('Stop waits for in-flight follower recovery before final provider shutdown', async () => {
  let starts = 0;
  let stops = 0;
  let releaseRecovery = null;
  const controller = {
    logger() {},
    start() {
      starts += 1;
      if (starts === 1) return Promise.resolve({ attached: true, owned: false, publicUrl: 'https://shared.example.test' });
      return new Promise(resolve => {
        releaseRecovery = () => resolve({ attached: false, owned: true, publicUrl: 'https://recovered.example.test' });
      });
    },
    status() { return { running: false, owned: false, attached: false }; },
    async stop() { stops += 1; return { stopped: true, reason: '' }; }
  };

  setTunnelController(controller);
  try {
    await startTunnel(8787);
    await waitFor(() => releaseRecovery);
    let settled = false;
    const stopping = stopTunnel().then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(settled, false, 'Stop must wait for recovery that already owns startup work');
    releaseRecovery();
    const result = await stopping;
    assert.equal(result.stopped, true);
    assert.equal(stops, 1);
  } finally {
    clearTunnelController(controller);
  }
});
