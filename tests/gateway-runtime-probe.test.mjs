import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const entry = path.join(root, 'gateway', 'server-runtime.mjs');
const PROBE_KIND = 'devmate-gateway-runtime-probe';

test('Gateway runtime probe loads the real bootstrap graph without touching instance state', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-runtime-probe-'));
  const configFile = path.join(stateRoot, 'config.json');
  try {
    const result = spawnSync(process.execPath, [entry], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      env: {
        ...process.env,
        DEVMATE_RUNTIME_PROBE: '1',
        DEVMATE_CONFIG: configFile,
        DEVMATE_DISABLE_INSTANCE_LOCK: '1',
        DEVMATE_DISABLE_EMBEDDED_RUNNER: '1'
      }
    });

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = String(result.stdout || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .find(value => value?.kind === PROBE_KIND);

    assert.equal(payload?.ok, true);
    assert.ok(Number.parseInt(String(payload?.node || '').split('.')[0], 10) >= 24, `unexpected probe Node version: ${payload?.node}`);
    assert.equal(fs.existsSync(configFile), false, 'runtime probe must not create or mutate config');
    assert.equal(fs.existsSync(path.join(stateRoot, 'state')), false, 'runtime probe must not acquire Gateway state or locks');
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
