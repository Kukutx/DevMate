import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditGodotProject } from '../gateway/plugins/godot-audit.mjs';
import { installQaBridge, inspectQaBridge, removeQaBridge } from '../gateway/plugins/godot-qa-bridge.mjs';
import { runNativeQa } from '../gateway/plugins/godot-native-qa.mjs';
import { defaultExportOutput, exportMatrix, exportProject } from '../gateway/plugins/godot-project.mjs';

async function fixture(name) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `devmate-godot-production-${name}-`));
  const project = path.join(root, 'game');
  await fsp.mkdir(project, { recursive: true });
  await fsp.writeFile(path.join(project, 'project.godot'), `[application]\nconfig/name="Test Game"\nrun/main_scene="res://main.tscn"\nconfig/icon="res://icon.svg"\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n\n[input]\nmove_right={}\n\n`, 'utf8');
  await fsp.writeFile(path.join(project, 'main.tscn'), '[gd_scene load_steps=2 format=3]\n[ext_resource path="res://player.gd" type="Script" id="1"]\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n', 'utf8');
  await fsp.writeFile(path.join(project, 'player.gd'), 'extends Node\n', 'utf8');
  await fsp.writeFile(path.join(project, 'icon.svg'), '<svg/>\n', 'utf8');
  await fsp.writeFile(path.join(project, 'export_presets.cfg'), `[preset.0]\nname="Web"\nplatform="Web"\nrunnable=true\nexport_path="build/web/index.html"\n\n[preset.1]\nname="Windows"\nplatform="Windows Desktop"\n`, 'utf8');
  const workspace = { id: 'app', name: 'app', root, mode: 'workspace-write', reference: false };
  let runImpl = async () => ({ exitCode: 0, timedOut: false, stdout: '', stderr: '' });
  const context = {
    settings: {
      executablePath: '',
      defaultProjectSubpath: 'game',
      defaultWebPreset: 'Web',
      defaultWebOutput: 'build/web/index.html',
      defaultExportRoot: 'build/exports',
      validationTimeoutMs: 300000,
      exportTimeoutMs: 600000
    },
    workspace: {
      get() { return workspace; },
      resolve(_workspace, subpath = '.') {
        const target = path.resolve(root, subpath || '.');
        const relative = path.relative(root, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside workspace');
        return target;
      }
    },
    executables: {
      find() { return process.execPath; },
      assertAllowed() {},
      run(...args) { return runImpl(...args); }
    },
    setRun(fn) { runImpl = fn; },
    audit: async () => {}
  };
  return { root, project, context };
}

test('audits Godot project resources, inputs, presets, and QA readiness', async t => {
  const current = await fixture('audit');
  t.after(() => fsp.rm(current.root, { recursive: true, force: true }));
  const first = await auditGodotProject(current.context, { workspaceId: 'app', projectSubpath: 'game' });
  assert.equal(first.ok, true);
  assert.deepEqual(first.inputs.actions, ['move_right']);
  assert.equal(first.presets.length, 2);
  assert.equal(first.readiness.exportable, true);
  assert.equal(first.readiness.nativeAcceptance, false);

  await fsp.appendFile(path.join(current.project, 'main.tscn'), '\n[ext_resource path="res://missing.png" type="Texture2D" id="2"]\n', 'utf8');
  const broken = await auditGodotProject(current.context, { workspaceId: 'app', projectSubpath: 'game' });
  assert.equal(broken.ok, false);
  assert.equal(broken.findings.some(item => item.code === 'missing_resource_references'), true);
});

test('installs, upgrades, and removes QA Bridge with backups', async t => {
  const current = await fixture('bridge');
  t.after(() => fsp.rm(current.root, { recursive: true, force: true }));
  const installed = await installQaBridge(current.context, { workspaceId: 'app', projectSubpath: 'game' });
  assert.equal(installed.changed, true);
  const status = await inspectQaBridge(current.project);
  assert.equal(status.current, true);
  assert.equal(status.version, 3);
  const repeated = await installQaBridge(current.context, { workspaceId: 'app', projectSubpath: 'game' });
  assert.equal(repeated.changed, false);
  const removed = await removeQaBridge(current.context, { workspaceId: 'app', projectSubpath: 'game' });
  assert.equal(removed.after.installed, false);
  assert.equal(removed.backups.length >= 1, true);
});

test('runs native Godot QA with deterministic input plan and state assertions', async t => {
  const current = await fixture('native');
  t.after(() => fsp.rm(current.root, { recursive: true, force: true }));
  await installQaBridge(current.context, { workspaceId: 'app', projectSubpath: 'game' });
  let plan = null;
  current.context.setRun(async (_executable, _args, options) => {
    if (options.environment.DEVMATE_QA_PLAN) plan = JSON.parse(await fsp.readFile(options.environment.DEVMATE_QA_PLAN, 'utf8'));
    await fsp.mkdir(path.dirname(options.environment.DEVMATE_QA_REPORT), { recursive: true });
    await fsp.writeFile(options.environment.DEVMATE_QA_REPORT, JSON.stringify({
      runtime: { bridge_ready: true, bridge_version: 3, completed: true, ok: true },
      player: { health: 5 },
      checkpoints: [{ name: 'ready' }]
    }), 'utf8');
    return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
  });
  const report = await runNativeQa(current.context, {
    workspaceId: 'app',
    projectSubpath: 'game',
    runForMs: 1000,
    inputActions: [{ atMs: 100, type: 'tap', action: 'move_right', durationMs: 50 }],
    assertions: [{ statePath: 'player.health', operator: 'gte', value: 5 }],
    requiredCheckpoints: ['ready']
  });
  assert.equal(report.ok, true);
  assert.equal(plan.actions.length, 2);
  assert.deepEqual(plan.actions.map(item => item.type), ['press', 'release']);
  assert.equal(report.assertionResults[0].passed, true);
});

test('exports arbitrary presets and an export matrix with generated outputs', async t => {
  const current = await fixture('exports');
  t.after(() => fsp.rm(current.root, { recursive: true, force: true }));
  current.context.setRun(async (_executable, args) => {
    const output = args.at(-1);
    await fsp.mkdir(path.dirname(output), { recursive: true });
    await fsp.writeFile(output, 'artifact', 'utf8');
    return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
  });
  const windows = await exportProject(current.context, {
    workspaceId: 'app', projectSubpath: 'game', preset: 'Windows', mode: 'release'
  });
  assert.equal(windows.ok, true);
  assert.match(windows.outputPath, /\.exe$/);
  assert.equal(windows.artifact.bytes, 8);
  assert.equal(defaultExportOutput({ name: 'Android', platform: 'Android' }, 'Game').endsWith('.apk'), true);

  const matrix = await exportMatrix(current.context, {
    workspaceId: 'app',
    projectSubpath: 'game',
    targets: [{ preset: 'Web' }, { preset: 'Windows' }],
    reportPath: 'artifacts/godot-export/matrix.json'
  });
  assert.equal(matrix.ok, true);
  assert.equal(matrix.passed, 2);
  assert.match(matrix.reportPath, /matrix\.json$/);
});
