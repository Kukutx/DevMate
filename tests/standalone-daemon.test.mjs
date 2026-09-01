import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initConfig } from '../scripts/standalone-runtime.mjs';
import { daemonStatus, startDaemon, stopDaemon, __test as daemon } from '../scripts/standalone-daemon.mjs';

async function tempDirectory(t, prefix) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('CLI daemon ownership requires both the dedicated owner prefix and exact config path', async t => {
  const state = await tempDirectory(t, 'devmate-daemon-owner-');
  const config = path.join(state, 'config.json');
  const lock = {
    pid: 12345,
    runtimeOwnerId: `${daemon.CLI_OWNER_PREFIX}test`,
    configPath: config
  };
  assert.equal(daemon.cliOwnedLock(lock, config), true);
  assert.equal(daemon.cliOwnedLock({ ...lock, runtimeOwnerId: 'vscode-host-1' }, config), false);
  assert.equal(daemon.cliOwnedLock({ ...lock, configPath: path.join(state, 'other.json') }, config), false);
});

test('standalone daemon starts a real Gateway, reports CLI ownership, and stops cleanly', async t => {
  const workspace = await tempDirectory(t, 'devmate-daemon-workspace-');
  const state = await tempDirectory(t, 'devmate-daemon-state-');
  const config = path.join(state, 'config.json');
  initConfig({ config, workspace, provider: 'ngrok', 'authentication-mode': 'none', port: '0' });

  let started = false;
  t.after(async () => {
    if (!started) return;
    try { await stopDaemon({ config, timeout: 10000 }); } catch {}
  });

  const result = await startDaemon({ config, timeout: 30000 });
  started = result.started === true || result.cliOwned === true;
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(result.attached, false);
  assert.match(String(result.owner || ''), /^cli-daemon-/);
  assert.ok(Number(result.port) > 0);

  const status = await daemonStatus({ config });
  assert.equal(status.ok, true);
  assert.equal(status.running, true);
  assert.equal(status.cliOwned, true);
  assert.equal(status.pid, result.pid);

  const stopped = await stopDaemon({ config, timeout: 10000 });
  started = false;
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopped, true);

  const after = await daemonStatus({ config });
  assert.equal(after.running, false);
});
