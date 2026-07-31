import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildGodotDependencyGraph, extractGodotReferences, parseSceneNodes } from '../gateway/plugins/godot-graph.mjs';
import { planGodotAutomation, suggestedCapabilitiesForPreset } from '../gateway/plugins/godot-plan.mjs';
import { __test as reportTest } from '../gateway/plugins/godot-report.mjs';
import { exportTemplateRoots, parseGodotVersion, runtimeHostCapabilities } from '../gateway/plugins/godot-runtime.mjs';
import { installQaBridge } from '../gateway/plugins/godot-qa-bridge.mjs';

function workspaceContext(root) {
  const workspace = { id: 'game', name: 'game', root, mode: 'workspace-write', reference: false };
  return {
    settings: { defaultProjectSubpath: '.' },
    workspace: {
      get() { return workspace; },
      resolve(_workspace, subpath, { mustExist = false, directory = false } = {}) {
        const target = path.resolve(root, subpath || '.');
        const relative = path.relative(root, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('escape');
        return target;
      }
    }
  };
}

async function createProject() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-godot-quality-'));
  await fsp.mkdir(path.join(root, 'levels'), { recursive: true });
  await fsp.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fsp.mkdir(path.join(root, '.devmate'), { recursive: true });
  await fsp.writeFile(path.join(root, 'project.godot'), `config_version=5

[application]
config/name="Quality Fixture"
run/main_scene="res://main.tscn"

[rendering]
renderer/rendering_method="gl_compatibility"

[input]
attack={
"deadzone": 0.5,
"events": []
}
`, 'utf8');
  await fsp.writeFile(path.join(root, 'main.tscn'), `[gd_scene load_steps=4 format=3]

[ext_resource type="Script" path="res://scripts/main.gd" id="1"]
[ext_resource type="PackedScene" path="res://levels/child.tscn" id="2"]
[ext_resource type="Texture2D" path="res://missing.png" id="3"]

[node name="Main" type="Node"]
script = ExtResource("1")

[node name="Child" parent="." instance=ExtResource("2")]
`, 'utf8');
  await fsp.writeFile(path.join(root, 'levels', 'child.tscn'), `[gd_scene format=3]
[node name="Child" type="Node2D"]
`, 'utf8');
  await fsp.writeFile(path.join(root, 'scripts', 'main.gd'), `extends Node
const CHILD = preload("res://levels/child.tscn")
`, 'utf8');
  await fsp.writeFile(path.join(root, 'export_presets.cfg'), `[preset.0]
name="Web"
platform="Web"
runnable=true
export_path="build/web/index.html"

[preset.1]
name="Windows Desktop"
platform="Windows Desktop"
`, 'utf8');
  await fsp.writeFile(path.join(root, '.devmate', 'automation.json'), JSON.stringify({
    schemaVersion: 1,
    plugins: {
      'devmate.godot': {
        projectSubpath: '.',
        exports: [{ preset: 'Windows Desktop' }],
        scenarios: [{
          id: 'native-smoke',
          kind: 'native',
          inputActions: [{ atMs: 100, type: 'tap', action: 'attack' }],
          assertions: [{ statePath: 'runtime.bridge_ready', operator: 'truthy' }]
        }, {
          id: 'web-smoke',
          kind: 'web',
          preset: 'Web',
          actions: [{ type: 'expect_visible', selector: 'canvas' }]
        }]
      }
    }
  }, null, 2), 'utf8');
  return root;
}

test('parses Godot runtime versions and host capabilities', () => {
  const parsed = parseGodotVersion('4.7.1.stable.official.abcdef');
  assert.equal(parsed.valid, true);
  assert.equal(parsed.major, 4);
  assert.equal(parsed.minor, 7);
  assert.equal(parsed.patch, 1);
  assert.equal(parsed.channel, 'stable');
  assert.equal(parsed.official, true);
  assert.deepEqual(runtimeHostCapabilities('linux', 'x64'), ['core', 'godot', 'linux-x64']);
  const roots = exportTemplateRoots({ platform: 'linux', env: { XDG_DATA_HOME: '/tmp/data' }, home: '/home/test' });
  assert.equal(roots.length, 1);
  assert.equal(roots[0].endsWith(path.join('tmp', 'data', 'godot', 'export_templates')), true);
});

test('extracts references and scene nodes', () => {
  const text = `[ext_resource path="res://scripts/player.gd" type="Script" id="1"]
[node name="Player" type="CharacterBody2D"]
const ICON = preload("res://ui/icon.png")`;
  assert.deepEqual(extractGodotReferences(text), ['res://scripts/player.gd', 'res://ui/icon.png']);
  assert.deepEqual(parseSceneNodes(text)[0], { name: 'Player', type: 'CharacterBody2D', parent: null, owner: null, instance: null });
});

test('builds bounded dependency graph with missing and reverse references', async t => {
  const root = await createProject();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const graph = await buildGodotDependencyGraph(workspaceContext(root), {
    entryPaths: ['res://main.tscn'],
    reverseTarget: 'res://levels/child.tscn'
  });
  assert.equal(graph.summary.nodes >= 4, true);
  assert.equal(graph.missing.includes('res://missing.png'), true);
  assert.equal(graph.reverseTarget.referencedBy.includes('res://main.tscn'), true);
  const main = graph.nodes.find(item => item.path === 'res://main.tscn');
  assert.equal(main.scene.nodeCount, 2);
});

test('plans exports and mixed automation with bridge and capability requirements', async t => {
  const root = await createProject();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const context = workspaceContext(root);
  let plan = await planGodotAutomation(context, {});
  assert.equal(plan.ok, false);
  assert.equal(plan.blockers.some(item => item.code === 'qa_bridge_required'), true);
  await installQaBridge(root);
  plan = await planGodotAutomation(context, {});
  assert.equal(plan.ok, true);
  assert.equal(plan.items.find(item => item.id === 'scenario:web-smoke').requiredCapabilities.includes('browser-qa'), true);
  assert.equal(plan.items.find(item => item.id === 'export:Windows Desktop').requiredCapabilities.includes('windows-x64'), true);
  assert.deepEqual(suggestedCapabilitiesForPreset({ platform: 'iOS' }), ['core', 'godot', 'macos-arm64', 'xcode']);
});

test('escapes report HTML and renders actionable status', () => {
  assert.equal(reportTest.escapeHtml('<script>'), '&lt;script&gt;');
  const html = reportTest.renderReport({
    generatedAt: '2026-01-01T00:00:00.000Z',
    ok: false,
    runtime: { version: { raw: '4.7.1' }, executableName: 'godot', readiness: { validate: true }, csharp: { ready: true }, exportTemplates: { available: false }, host: { capabilities: ['core', 'godot'] } },
    audit: { project: { name: '<Game>' }, summary: { errors: 1, warnings: 0 }, issues: { errors: [{ level: 'error', code: 'broken', message: '<bad>' }], warnings: [], info: [] } },
    graph: { summary: { nodes: 1, edges: 0, missing: 0 }, entries: ['res://main.tscn'], missing: [], cycles: [] },
    plan: { summary: { ready: 0, items: 1 }, items: [{ id: 'scenario:test', tool: 'godot_native_test', blockers: [{ level: 'error', code: 'blocked', message: 'No' }], warnings: [], requiredCapabilities: ['godot'] }] }
  });
  assert.match(html, /&lt;Game&gt;/);
  assert.match(html, /ATTENTION/);
});
