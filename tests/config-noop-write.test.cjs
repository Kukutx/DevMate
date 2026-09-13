'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SUPPORTED_CONFIG_VERSION,
  atomicWriteJson,
  updateConfig
} = require('../shared/config-store.cjs');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('does not replace config.json when a locked mutation makes no content change', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-config-noop-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  atomicWriteJson(file, {
    version: SUPPORTED_CONFIG_VERSION,
    appVersion: '3.8.6',
    instanceId: 'stable-instance',
    server: { port: 8787 }
  });

  const before = await fsp.stat(file, { bigint: true });
  await delay(1100);
  const result = updateConfig(file, config => config);
  const unchanged = await fsp.stat(file, { bigint: true });

  assert.equal(result.instanceId, 'stable-instance');
  assert.equal(unchanged.mtimeNs, before.mtimeNs);
  assert.equal(unchanged.size, before.size);

  await delay(20);
  const mutated = updateConfig(file, config => {
    config.server.port = 8788;
    config.appVersion = '3.8.5';
    config.runtime = { marker: true };
    return config;
  });
  const changed = await fsp.stat(file, { bigint: true });
  assert.ok(changed.mtimeNs > unchanged.mtimeNs);
  assert.equal(mutated.server.port, 8787);
  assert.equal(mutated.instanceId, 'stable-instance');
  assert.equal(mutated.appVersion, '3.8.6');
  assert.equal(mutated.runtime.marker, true);

  const repairedPort = updateConfig(file, config => {
    config.server.port = 8788;
    return config;
  }, { allowRuntimePortChange: true });
  assert.equal(repairedPort.server.port, 8788);

  const blockedPromotion = updateConfig(file, config => {
    config.appVersion = '3.8.7';
    return config;
  });
  assert.equal(blockedPromotion.appVersion, '3.8.6');

  const promoted = updateConfig(file, config => {
    config.appVersion = '3.8.7';
    return config;
  }, { allowRuntimeVersionPromotion: true });
  assert.equal(promoted.appVersion, '3.8.7');
});
