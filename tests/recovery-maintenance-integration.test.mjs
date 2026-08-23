import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pruneRecoveryState, recoveryStateSummary } from '../gateway/maintenance.mjs';

async function write(file, content, mtime) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
  await fsp.utimes(file, mtime, mtime);
}

test('Gateway recovery maintenance follows the active custom config name and preserves replacement evidence', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-recovery-maintenance-'));
  const previousConfig = process.env.DEVMATE_CONFIG;
  try {
    const configFile = path.join(root, 'custom-instance.json');
    const stateRoot = path.join(root, 'state');
    const old = new Date('2026-05-01T00:00:00.000Z');
    const configCorrupt = `${configFile}.corrupt-old`;
    const configLegacy = `${configFile}.legacy-v11-old.json`;
    const configReplacement = `${configFile}.replace-newer-runtime`;
    const durableCorrupt = path.join(stateRoot, 'runtime-state.json.corrupt-old');
    const oauthCorrupt = path.join(stateRoot, 'oauth-secrets.json.corrupt-old');
    const tunnelInvalid = path.join(stateRoot, 'tunnel.runtime.json.invalid-json-old');
    const stateReplacement = path.join(stateRoot, 'runtime-state.json.replace-newer-runtime');

    for (const file of [configCorrupt, configLegacy, configReplacement, durableCorrupt, oauthCorrupt, tunnelInvalid, stateReplacement]) {
      await write(file, '{}\n', old);
    }
    process.env.DEVMATE_CONFIG = configFile;

    const paths = {
      stateRoot,
      backupRoot: path.join(stateRoot, 'backups'),
      auditLog: path.join(stateRoot, 'audit.jsonl')
    };
    const before = recoveryStateSummary(paths);
    assert.equal(before.totalFiles, 5, 'only known quarantine artifacts belong to the retention inventory');

    const result = pruneRecoveryState(paths, Date.parse('2026-06-19T00:00:00.000Z'));
    assert.equal(result.config.deleted.length, 2);
    assert.equal(result.state.deleted.length, 3);
    for (const file of [configCorrupt, configLegacy, durableCorrupt, oauthCorrupt, tunnelInvalid]) {
      await assert.rejects(fsp.stat(file));
    }
    await fsp.stat(configReplacement);
    await fsp.stat(stateReplacement);
    assert.equal(recoveryStateSummary(paths).totalFiles, 0);
  } finally {
    if (previousConfig === undefined) delete process.env.DEVMATE_CONFIG;
    else process.env.DEVMATE_CONFIG = previousConfig;
    await fsp.rm(root, { recursive: true, force: true });
  }
});
