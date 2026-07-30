import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { automationManifestTemplate, loadAutomationManifest, pluginAutomationConfig, scenarioById } from '../gateway/plugins/automation-manifest.mjs';

function contextFor(root) {
  const workspace = { id: 'workspace', name: 'workspace', root };
  return {
    workspace: {
      get() { return workspace; },
      resolve(_workspace, subpath) {
        const target = path.resolve(root, subpath || '.');
        const rel = path.relative(root, target);
        if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('escape');
        return target;
      }
    }
  };
}

test('loads a namespaced versioned automation manifest', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-automation-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, '.devmate'), { recursive: true });
  const manifest = automationManifestTemplate();
  manifest.plugins['devmate.godot'].scenarios.push({ id: 'smoke' });
  await fsp.writeFile(path.join(root, '.devmate', 'automation.json'), JSON.stringify(manifest), 'utf8');
  const loaded = await loadAutomationManifest(contextFor(root), {});
  assert.equal(loaded.exists, true);
  const config = pluginAutomationConfig(loaded.manifest, 'devmate.godot');
  assert.equal(scenarioById(config.scenarios, 'smoke').id, 'smoke');
});

test('rejects unsupported automation manifest versions', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-automation-bad-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, '.devmate'), { recursive: true });
  await fsp.writeFile(path.join(root, '.devmate', 'automation.json'), JSON.stringify({ schemaVersion: 99, plugins: {} }), 'utf8');
  await assert.rejects(() => loadAutomationManifest(contextFor(root), {}), /Unsupported DevMate automation schemaVersion/);
});
