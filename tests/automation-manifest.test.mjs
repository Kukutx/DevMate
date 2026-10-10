import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCapabilities } from '../runtime/capabilities.mjs';
import { __test, automationManifestTemplate, parseAutomationConfig, pluginAutomationConfig, scenarioById } from '../runtime/engines/automation-manifest.mjs';
import { godotAutomationConfigSchema } from '../runtime/engines/godot.mjs';

// The manifest is read through the real capability registry and the real project
// path policy: .devmate is a protected directory with exactly this file allowed in it.
async function project(t) {
  const temp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-automation-')));
  const root = path.join(temp, 'project');
  await fsp.mkdir(path.join(root, '.devmate'), { recursive: true });
  const record = { id: 'workspace', name: 'workspace', root, access: 'write' }, settings = new Map();
  const service = { project: () => record, store: { event() {}, setting(key, value) { if (value !== undefined) settings.set(key, value); return settings.get(key); } } };
  const capabilities = await createCapabilities({ service, instanceRoot: path.join(temp, 'instance') });
  t.after(async () => { await capabilities.close(); await fsp.rm(temp, { recursive: true, force: true }); });
  const call = async (capability, input = {}, callerRole = 'read') => (await capabilities.call({ projectId: record.id, capability, input }, { callerRole })).structuredContent;
  return { root, call, write: manifest => fsp.writeFile(path.join(root, '.devmate', 'automation.json'), JSON.stringify(manifest), 'utf8') };
}

test('loads a namespaced versioned automation manifest from the protected .devmate directory', async t => {
  const f = await project(t);
  const manifest = automationManifestTemplate();
  manifest.plugins['devmate.godot'].scenarios.push({ id: 'smoke' });
  await f.write(manifest);
  const status = await f.call('automation.manifest_status');
  assert.deepEqual([status.exists, status.manifestPath, status.schemaVersion], [true, '.devmate/automation.json', 1]);
  const loaded = await f.call('godot.automation_manifest');
  assert.equal(scenarioById(loaded.config.scenarios, 'smoke').id, 'smoke');
  assert.equal(scenarioById(pluginAutomationConfig(manifest, 'devmate.godot').scenarios, 'smoke').id, 'smoke');
  assert.throws(() => scenarioById(loaded.config.scenarios, 'absent'), /Automation scenario not found: absent/);
});

test('rejects unsupported automation manifest versions and names an invalid key', async t => {
  const f = await project(t);
  await f.write({ schemaVersion: 99, plugins: {} });
  await assert.rejects(f.call('automation.manifest_status'), /Unsupported DevMate automation schemaVersion/);
  await assert.rejects(f.call('godot.automation_manifest'), /Unsupported DevMate automation schemaVersion/);
  const invalid = { schemaVersion: 1, plugins: { 'devmate.godot': { scenarios: [{ id: 'bad', timeoutMs: 1 }] } } };
  assert.throws(() => parseAutomationConfig(godotAutomationConfigSchema, invalid, 'devmate.godot', '.devmate/automation.json'),
    error => error.code === 'invalid_manifest' && /\.devmate\/automation\.json is invalid: plugins\.devmate\.godot\.scenarios\.0\.timeoutMs: /.test(error.message));
});

test('a missing manifest says how to create one', async t => {
  const f = await project(t);
  assert.equal((await f.call('automation.manifest_status')).exists, false);
  await assert.rejects(f.call('godot.acceptance_run_saved', { scenarioId: 'smoke' }, 'owner'),
    /automation manifest not found: \.devmate\/automation\.json\. Start one from automation\.manifest_template, or for a Godot project with godot\.automation_bootstrap/);
});

test('automation manifest path allows only safe project metadata locations', () => {
  assert.equal(__test.safeManifestPath('.devmate/automation.json'), '.devmate/automation.json');
  assert.equal(__test.safeManifestPath('game/.devmate/automation.json'), 'game/.devmate/automation.json');
  for (const value of ['../automation.json', '/tmp/automation.json', '.aws/.devmate/automation.json', 'secrets/automation.json', '.npmrc']) {
    assert.throws(() => __test.safeManifestPath(value), value);
  }
});
