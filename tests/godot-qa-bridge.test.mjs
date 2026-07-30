import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectQaBridge, qaBridgeTemplate, QA_BRIDGE_SCRIPT_PATH } from '../gateway/plugins/godot-qa-bridge.mjs';

test('reports and templates the optional Godot QA bridge', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-godot-bridge-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, 'project.godot'), '[application]\nconfig/name="Test"\n', 'utf8');
  assert.equal((await inspectQaBridge(root)).installed, false);
  const template = qaBridgeTemplate();
  await fsp.mkdir(path.join(root, path.dirname(QA_BRIDGE_SCRIPT_PATH)), { recursive: true });
  await fsp.writeFile(path.join(root, QA_BRIDGE_SCRIPT_PATH), template.files[0].content, 'utf8');
  await fsp.appendFile(path.join(root, 'project.godot'), `\n[autoload]\n${template.projectConfig.line}\n`, 'utf8');
  const status = await inspectQaBridge(root);
  assert.equal(status.installed, true);
  assert.match(template.files[0].content, /__DEVMATE_QA_STATE__/);
  assert.match(template.productionSafety, /debug Web exports/);
});
