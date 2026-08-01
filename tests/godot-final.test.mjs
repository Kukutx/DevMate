import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrapGodotAutomation } from '../gateway/plugins/godot-bootstrap.mjs';
import { comparePerformanceBaseline, createPerformanceBaseline, writePerformanceBaseline } from '../gateway/plugins/godot-baseline.mjs';
import { summarizePerformance } from '../gateway/plugins/godot-performance.mjs';
import { evaluateGodotReleaseGate } from '../gateway/plugins/godot-release-gate.mjs';

function contextFor(root) {
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
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-godot-final-'));
  await fsp.mkdir(path.join(root, 'addons', 'gut'), { recursive: true });
  await fsp.mkdir(path.join(root, 'tests'), { recursive: true });
  await fsp.writeFile(path.join(root, 'project.godot'), `config_version=5

[application]
config/name="Final Fixture"
run/main_scene="res://main.tscn"

[rendering]
renderer/rendering_method="gl_compatibility"

[input]
attack={
"deadzone": 0.5,
"events": []
}
`, 'utf8');
  await fsp.writeFile(path.join(root, 'main.tscn'), '[gd_scene format=3]\n[node name="Main" type="Node"]\n', 'utf8');
  await fsp.writeFile(path.join(root, 'export_presets.cfg'), `[preset.0]
name="Web"
platform="Web"
runnable=true
export_path="build/web/index.html"

[preset.1]
name="Linux"
platform="Linux/X11"
`, 'utf8');
  await fsp.writeFile(path.join(root, 'addons', 'gut', 'gut_cmdln.gd'), 'extends SceneTree\n', 'utf8');
  await fsp.writeFile(path.join(root, 'tests', 'test_main.gd'), 'extends Node\n', 'utf8');
  return root;
}

function performanceReport(multiplier = 1) {
  return {
    runtime: { scene: 'res://main.tscn' },
    performance: {
      enabled: true,
      sample_interval_ms: 250,
      samples: Array.from({ length: 12 }, (_, index) => ({
        elapsed_ms: 1000 + index * 250,
        fps: 60 / multiplier,
        process_ms: 4 * multiplier,
        physics_ms: 1 * multiplier,
        memory_static_bytes: 1000000 * multiplier,
        object_count: 100,
        resource_count: 20,
        node_count: 25,
        orphan_node_count: 0,
        draw_calls: 10 * multiplier,
        video_memory_bytes: 0,
        physics_2d_active: 2,
        physics_2d_pairs: 1,
        physics_3d_active: 0,
        physics_3d_pairs: 0
      }))
    }
  };
}

test('creates performance baseline and detects regression directionally', () => {
  const baselineSummary = summarizePerformance(performanceReport(1), { warmupMs: 1000 });
  const baseline = createPerformanceBaseline(baselineSummary, { id: 'main' });
  const stable = comparePerformanceBaseline(summarizePerformance(performanceReport(1.02), { warmupMs: 1000 }), baseline, { maxRegressionPercent: 5 });
  assert.equal(stable.ok, true);
  const regressed = comparePerformanceBaseline(summarizePerformance(performanceReport(1.25), { warmupMs: 1000 }), baseline, { maxRegressionPercent: 10 });
  assert.equal(regressed.ok, false);
  assert.equal(regressed.comparisons.some(item => item.key === 'fps_p05' && !item.passed), true);
  assert.equal(regressed.comparisons.some(item => item.key === 'process_ms_p95' && !item.passed), true);
});

test('writes a workspace-contained performance baseline from a report', async t => {
  const root = await createProject();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'artifacts', 'godot-performance'), { recursive: true });
  await fsp.writeFile(path.join(root, 'artifacts', 'godot-performance', 'latest.json'), JSON.stringify(performanceReport()), 'utf8');
  const result = await writePerformanceBaseline(contextFor(root), { baselineId: 'main', force: false });
  assert.equal(result.baseline.id, 'main');
  assert.equal(result.baseline.evaluatedSamples, 12);
  assert.equal(result.baselinePath, '.devmate/baselines/godot/main.json');
  const persisted = JSON.parse(await fsp.readFile(path.join(root, result.baselinePath), 'utf8'));
  assert.equal(persisted.metrics.fps_p05, 60);
});

test('bootstraps and merges automation without replacing existing scenario ids', async t => {
  const root = await createProject();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, '.devmate'), { recursive: true });
  await fsp.writeFile(path.join(root, '.devmate', 'automation.json'), JSON.stringify({
    schemaVersion: 1,
    plugins: {
      'devmate.godot': {
        projectSubpath: '.',
        scenarios: [{ id: 'native-smoke', kind: 'native', description: 'User-owned scenario', runForMs: 9000 }]
      }
    }
  }), 'utf8');
  const result = await bootstrapGodotAutomation(contextFor(root), { merge: true });
  const core = result.manifest.plugins['devmate.godot'];
  assert.equal(core.scenarios.filter(item => item.id === 'native-smoke').length, 1);
  assert.equal(core.scenarios.find(item => item.id === 'native-smoke').description, 'User-owned scenario');
  assert.equal(core.scenarios.some(item => item.id === 'web-smoke'), true);
  assert.equal(result.manifest.plugins['devmate.godot-advanced'].scenarios.some(item => item.id === 'performance-main'), true);
  assert.equal(result.manifest.plugins['devmate.godot-advanced'].scenarios.some(item => item.id === 'tests-gut'), true);
  assert.equal(result.backupPath != null, true);
});

test('release gate accepts fresh passing evidence and blocks missing required types', async t => {
  const root = await createProject();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const evidenceRoot = path.join(root, 'artifacts', 'evidence');
  await fsp.mkdir(evidenceRoot, { recursive: true });
  const files = {
    quality: { ok: true, audit: { summary: { errors: 0, warnings: 1 } }, graph: { summary: { missing: 0 } }, plan: { summary: { blocked: 0 } } },
    tests: { ok: true, junit: { tests: 8, failures: 0, errors: 0, skipped: 1 } },
    performance: { ok: true, performance: { summary: { evaluatedSamples: 20 }, budget: { ok: true } }, regression: { ok: true } },
    exports: { ok: true, completed: 2, passed: 2, failed: 0, results: [{ ok: true }, { ok: true }] }
  };
  const evidence = [];
  for (const [type, value] of Object.entries(files)) {
    const relative = `artifacts/evidence/${type}.json`;
    await fsp.writeFile(path.join(root, relative), JSON.stringify(value), 'utf8');
    evidence.push({ type, path: relative });
  }
  const passed = await evaluateGodotReleaseGate(contextFor(root), { evidence });
  assert.equal(passed.ok, true);
  assert.equal(passed.summary.blockers, 0);
  assert.equal((await fsp.stat(path.join(root, passed.reportPath))).isFile(), true);
  const failed = await evaluateGodotReleaseGate(contextFor(root), { evidence: evidence.filter(item => item.type !== 'performance'), reportPath: 'artifacts/godot-release/missing.json' });
  assert.equal(failed.ok, false);
  assert.equal(failed.blockers.some(item => item.code === 'required_evidence_missing' && item.evidenceType === 'performance'), true);
});
