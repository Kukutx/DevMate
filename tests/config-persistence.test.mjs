import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import configStore from '../shared/config-store.cjs';
import { runWithWorkSessionContext } from '../gateway/request-context.mjs';

const { SUPPORTED_CONFIG_VERSION } = configStore;
const moduleUrl = pathToFileURL(path.resolve('gateway/local-shared.mjs')).href;

async function withConfig(t, prefix, initial = { version: SUPPORTED_CONFIG_VERSION }) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  await fsp.writeFile(configPath, `${JSON.stringify(initial)}\n`, 'utf8');
  const previous = process.env.DEVMATE_CONFIG;
  process.env.DEVMATE_CONFIG = configPath;
  t.after(() => {
    if (previous === undefined) delete process.env.DEVMATE_CONFIG;
    else process.env.DEVMATE_CONFIG = previous;
  });
  const shared = await import(`${moduleUrl}?test=${prefix}-${Date.now()}-${Math.random()}`);
  return { directory, configPath, shared };
}

test('writes DevMate config atomically with valid JSON and no temporary files', async t => {
  const { directory, configPath, shared } = await withConfig(t, 'devmate-config-');
  const config = shared.readConfig();
  config.nested = { ready: true };
  shared.writeConfig(config);
  assert.deepEqual(shared.readConfig(), { version: SUPPORTED_CONFIG_VERSION, nested: { ready: true } });
  const entries = await fsp.readdir(directory);
  assert.deepEqual(entries, ['config.json']);
  if (process.platform !== 'win32') {
    const mode = fs.statSync(configPath).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test('rejects unsourced whole-document replacement', async t => {
  const { shared } = await withConfig(t, 'devmate-config-unsourced-', { version: SUPPORTED_CONFIG_VERSION, keep: true });
  assert.throws(() => shared.writeConfig({ version: SUPPORTED_CONFIG_VERSION, replace: true }), error => {
    assert.equal(error.code, 'config_snapshot_required');
    return true;
  });
  assert.deepEqual(shared.readConfig(), { version: SUPPORTED_CONFIG_VERSION, keep: true });
});

test('rejects stale configuration snapshots instead of losing a concurrent update', async t => {
  const { configPath, shared } = await withConfig(t, 'devmate-config-conflict-', { version: SUPPORTED_CONFIG_VERSION, first: false, second: false });
  const first = shared.readConfig();
  const stale = shared.readConfig();
  first.first = true;
  shared.writeConfig(first);
  stale.second = true;
  assert.throws(() => shared.writeConfig(stale), error => {
    assert.equal(error.code, 'config_conflict');
    return true;
  });
  assert.deepEqual(JSON.parse(await fsp.readFile(configPath, 'utf8')), { version: SUPPORTED_CONFIG_VERSION, first: true, second: false });
});

test('retries a synchronous config mutation after a detected concurrent writer', async t => {
  const { configPath, shared } = await withConfig(t, 'devmate-config-retry-', { version: SUPPORTED_CONFIG_VERSION, external: 0, local: 0 });
  let attempts = 0;
  shared.mutateConfig(config => {
    attempts += 1;
    config.local += 1;
    if (attempts === 1) {
      fs.writeFileSync(configPath, `${JSON.stringify({ version: SUPPORTED_CONFIG_VERSION, external: 1, local: 0 })}\n`, 'utf8');
    }
    return config;
  });
  assert.equal(attempts, 2);
  assert.deepEqual(JSON.parse(await fsp.readFile(configPath, 'utf8')), { version: SUPPORTED_CONFIG_VERSION, external: 1, local: 1 });
});

test('recovers an interrupted Windows-style replacement backup', async t => {
  const { directory, configPath, shared } = await withConfig(t, 'devmate-config-recovery-');
  await fsp.rm(configPath);
  const backup = `${configPath}.replace-123-456`;
  await fsp.writeFile(backup, `${JSON.stringify({ version: SUPPORTED_CONFIG_VERSION, recovered: true })}\n`, 'utf8');
  assert.deepEqual(shared.readConfig(), { version: SUPPORTED_CONFIG_VERSION, recovered: true });
  assert.equal(fs.existsSync(configPath), true);
  assert.equal(fs.existsSync(backup), false);
  assert.deepEqual(await fsp.readdir(directory), ['config.json']);
});

test('restores a valid replacement before quarantining a corrupt main config', async t => {
  const { directory, configPath, shared } = await withConfig(t, 'devmate-config-corrupt-recovery-');
  await fsp.writeFile(configPath, '{"broken":', 'utf8');
  const backup = `${configPath}.replace-123-789`;
  await fsp.writeFile(backup, `${JSON.stringify({ version: SUPPORTED_CONFIG_VERSION, restored: true })}\n`, 'utf8');
  assert.deepEqual(shared.readConfig(), { version: SUPPORTED_CONFIG_VERSION, restored: true });
  assert.equal(fs.existsSync(backup), false);
  const entries = await fsp.readdir(directory);
  assert.equal(entries.some(name => name.startsWith('config.json.corrupt-')), true);
  assert.deepEqual(JSON.parse(await fsp.readFile(configPath, 'utf8')), { version: SUPPORTED_CONFIG_VERSION, restored: true });
});

test('redacts nested credentials, raw DevMate tokens, and circular audit values', async t => {
  const { shared } = await withConfig(t, 'devmate-config-redaction-');
  const secret = `${'a'.repeat(20)}_${'b'.repeat(22)}`;
  const value = {
    nested: {
      authorization: 'Bearer example-credential',
      note: `member=dmt_data_ops_${secret}`,
      child: { apiKey: 'example-value' }
    }
  };
  value.self = value;
  const redacted = shared.redactSensitiveValue(value);
  assert.equal(redacted.nested.authorization, 'redacted');
  assert.equal(redacted.nested.child.apiKey, 'redacted');
  assert.equal(redacted.nested.note.includes('dmt_'), false);
  assert.equal(redacted.self, '[circular]');
});

test('bounds each audit event and preserves trusted system fields', async t => {
  const { directory, shared } = await withConfig(t, 'devmate-config-audit-', {
    version: SUPPORTED_CONFIG_VERSION,
    permissions: { profile: 'fullAccess' }
  });
  const secret = `${'a'.repeat(20)}_${'b'.repeat(22)}`;
  await runWithWorkSessionContext('work-real', () => shared.audit('large_event', {
    time: 'forged',
    action: 'forged',
    workSessionId: 'forged',
    permissionProfile: 'forged',
    nested: { token: `dmt_member_${secret}` },
    huge: 'x'.repeat(200000)
  }));
  const auditPath = path.join(directory, 'state', 'audit.jsonl');
  const line = (await fsp.readFile(auditPath, 'utf8')).trim();
  assert.ok(Buffer.byteLength(line, 'utf8') <= shared.MAX_AUDIT_ENTRY_BYTES);
  const entry = JSON.parse(line);
  assert.equal(entry.action, 'large_event');
  assert.equal(entry.workSessionId, 'work-real');
  assert.equal(entry.permissionProfile, 'fullAccess');
  assert.equal(entry.truncated, true);
  assert.ok(entry.originalBytes > shared.MAX_AUDIT_ENTRY_BYTES);
  assert.equal(line.includes('dmt_member_'), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(auditPath).mode & 0o777, 0o600);
  }
});

test('accepts an explicit trusted work session ID after session state is cleared', async t => {
  const { directory, shared } = await withConfig(t, 'devmate-config-finished-session-', {
    version: SUPPORTED_CONFIG_VERSION,
    permissions: { profile: 'fullAccess' }
  });
  await shared.audit('work_session_finish', { workSessionId: 'forged', title: 'done' }, { workSessionId: 'work-real' });
  const auditPath = path.join(directory, 'state', 'audit.jsonl');
  const entry = JSON.parse((await fsp.readFile(auditPath, 'utf8')).trim());
  assert.equal(entry.workSessionId, 'work-real');
  assert.equal(entry.action, 'work_session_finish');
  assert.equal(entry.title, 'done');
});

test('rejects malformed configuration roots with the config path in the error', async t => {
  const { configPath, shared } = await withConfig(t, 'devmate-config-invalid-');
  await fsp.writeFile(configPath, '[]\n', 'utf8');
  assert.throws(() => shared.readConfig(), error => {
    assert.equal(error.code, 'config_invalid_root');
    assert.equal(error.configFile, configPath);
    assert.match(error.message, /DevMate config root must be a JSON object/);
    return true;
  });
});
