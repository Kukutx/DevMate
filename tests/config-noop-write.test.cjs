'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
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
    version: 11,
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
  updateConfig(file, config => {
    config.server.port = 8788;
    return config;
  });
  const changed = await fsp.stat(file, { bigint: true });
  assert.ok(changed.mtimeNs > unchanged.mtimeNs);
});
