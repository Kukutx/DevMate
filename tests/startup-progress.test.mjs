import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-startup-progress-'));
}

test('startup progress records bounded durable stages and temporary maintenance nesting', async () => {
  const dir = await tempDir();
  try {
    const configPath = path.join(dir, 'config.json');
    await fsp.writeFile(configPath, '{}\n', 'utf8');
    process.env.DEVMATE_CONFIG = configPath;
    process.env.DEVMATE_RUNTIME_OWNER_ID = 'startup-progress-test-owner';

    const progress = await import(`../gateway/startup-progress.mjs?test=${Date.now()}`);
    assert.equal(progress.beginStartupProgress('runtime_config'), true);
    progress.enterStartupStage('instance_lock');
    progress.enterStartupStage('server_module');
    await progress.withStartupStage('maintenance', async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
    });
    progress.completeStartupProgress('server_module_loaded');

    const file = path.join(dir, 'state', 'gateway-startup.json');
    const snapshot = JSON.parse(await fsp.readFile(file, 'utf8'));
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.ownerId, 'startup-progress-test-owner');
    assert.equal(snapshot.status, 'server_module_loaded');
    assert.equal(snapshot.finalStage, 'server_module_loaded');
    assert.equal(snapshot.currentStage, null);
    assert(snapshot.totalDurationMs >= 0);
    const stages = snapshot.completedStages.map(item => item.stage);
    assert(stages.includes('runtime_config'));
    assert(stages.includes('instance_lock'));
    assert(stages.includes('server_module'));
    assert(stages.includes('maintenance'));
  } finally {
    delete process.env.DEVMATE_RUNTIME_OWNER_ID;
    delete process.env.DEVMATE_CONFIG;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a failed nested startup stage remains the reported failure stage', async () => {
  const dir = await tempDir();
  try {
    const configPath = path.join(dir, 'config.json');
    await fsp.writeFile(configPath, '{}\n', 'utf8');
    process.env.DEVMATE_CONFIG = configPath;
    process.env.DEVMATE_RUNTIME_OWNER_ID = 'startup-progress-failure-owner';

    const progress = await import(`../gateway/startup-progress.mjs?failure=${Date.now()}`);
    progress.beginStartupProgress('server_module');
    const failure = new Error('maintenance failed');
    failure.code = 'EIO';
    await assert.rejects(
      progress.withStartupStage('maintenance', async () => { throw failure; }),
      /maintenance failed/
    );
    progress.failStartupProgress(failure);

    const file = path.join(dir, 'state', 'gateway-startup.json');
    const snapshot = JSON.parse(await fsp.readFile(file, 'utf8'));
    assert.equal(snapshot.status, 'failed');
    assert.equal(snapshot.failedStage, 'maintenance');
    assert.equal(snapshot.error.code, 'EIO');
  } finally {
    delete process.env.DEVMATE_RUNTIME_OWNER_ID;
    delete process.env.DEVMATE_CONFIG;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
