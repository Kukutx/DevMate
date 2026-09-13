'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  bridgeProcessIsLive,
  isObsidianBridge,
  liveObsidianBridgeEntries,
  pruneDeadObsidianBridges
} = require('../shared/host-bridge-registry.cjs');

test('Obsidian bridge registry keeps legacy and live records but rejects proven dead PIDs', () => {
  const config = {
    hostBridges: {
      legacy: { kind: 'obsidian', url: 'http://127.0.0.1:1' },
      dead: { kind: 'obsidian', pid: 100 },
      live: { kind: 'obsidian', pid: 200 },
      other: { kind: 'other', pid: 300 }
    }
  };
  const options = { pidIsRunning: pid => pid === 200 };
  assert.equal(isObsidianBridge('legacy', config.hostBridges.legacy), true);
  assert.equal(bridgeProcessIsLive(config.hostBridges.legacy, options), true);
  assert.equal(bridgeProcessIsLive(config.hostBridges.dead, options), false);
  assert.deepEqual(liveObsidianBridgeEntries(config, options).map(([id]) => id).sort(), ['legacy', 'live']);
});

test('Obsidian bridge pruning removes only records with a proven dead current-format PID', () => {
  const config = {
    hostBridges: {
      dead: { kind: 'obsidian', pid: 100 },
      live: { kind: 'obsidian', pid: 200 },
      legacy: { kind: 'obsidian' },
      other: { kind: 'other', pid: 100 }
    }
  };
  const removed = pruneDeadObsidianBridges(config, { pidIsRunning: pid => pid === 200 });
  assert.equal(removed, 1);
  assert.deepEqual(Object.keys(config.hostBridges).sort(), ['legacy', 'live', 'other']);
});
