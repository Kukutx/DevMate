import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DevMateService } from '../runtime/service.mjs';
import { advancedAutomationConfigSchema } from '../runtime/engines/godot-advanced-automation.mjs';
import { godotAutomationConfigSchema } from '../runtime/engines/godot.mjs';

// Everything here goes through a real DevMateService, the real capability registry and the
// real project path policy. The "Godot" is a copy of the Node executable: a real child
// process that matches the Godot executable pattern and fails every Godot command line.
const owner = Object.freeze({ id: 'owner', role: 'owner', surface: 'local' });
const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-manifest-cycle-'));
const godot = path.join(shared, process.platform === 'win32' ? 'godot.exe' : 'godot');
fs.copyFileSync(process.execPath, godot);
fs.chmodSync(godot, 0o755);
test.after(() => fs.rmSync(shared, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

async function fixture(t, { framework = 'gut' } = {}) {
  const temp = fs.mkdtempSync(path.join(shared, 'case-')), root = path.join(temp, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'project.godot'), 'config_version=5\n\n[application]\nconfig/name="Cycle"\nrun/main_scene="res://main.tscn"\n');
  fs.writeFileSync(path.join(root, 'main.tscn'), '[gd_scene format=3]\n[node name="Main" type="Node2D"]\n');
  fs.writeFileSync(path.join(root, 'export_presets.cfg'), '[preset.0]\nname="Web"\nplatform="Web"\nrunnable=true\nexport_path="build/web/index.html"\n');
  const script = framework === 'gut' ? 'addons/gut/gut_cmdln.gd' : 'addons/gdUnit4/bin/GdUnitCmdTool.gd';
  fs.mkdirSync(path.dirname(path.join(root, script)), { recursive: true });
  fs.writeFileSync(path.join(root, script), 'extends SceneTree\n');
  const service = new DevMateService({ instanceRoot: path.join(temp, 'state'), endpoint: 'http://127.0.0.1:1/api/agent', adapterFactory: () => ({}),
    config: { engineSettings: { godot: { executablePath: godot } } } });
  t.after(() => service.close());
  const project = await service.call('project.create', { root }, owner);
  const call = async (capability, input = {}) => (await service.call('capability.call', { projectId: project.id, capability, input }, owner)).structuredContent;
  const manifestFile = path.join(root, '.devmate', 'automation.json');
  return { root, service, project, call, manifestFile, readManifest: () => JSON.parse(fs.readFileSync(manifestFile, 'utf8')) };
}

test('bootstrap, read, run-saved and baseline all work once .devmate exists', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const created = await f.call('godot.automation_bootstrap');
  assert.equal(created.changed, true);
  assert.equal(created.manifestPath, '.devmate/automation.json');
  assert.equal(fs.statSync(path.join(f.root, '.devmate')).isDirectory(), true);

  // Every reader of the manifest the bootstrap just wrote, with the protected directory present.
  const core = await f.call('godot.automation_manifest');
  assert.equal(core.exists, true);
  assert.deepEqual(core.config.scenarios.map(item => item.id), ['native-smoke', 'web-smoke']);
  assert.deepEqual(core.config.exports, [{ preset: 'Web', outputPath: 'build/web/index.html' }]);
  const advanced = await f.call('godot.advanced_manifest');
  assert.deepEqual(advanced.config.scenarios.map(item => [item.id, item.kind]), [['performance-main', 'performance'], ['tests-gut', 'tests']]);
  assert.equal(advanced.config.scenarios[0].headless, true);
  assert.equal(advanced.config.scenarios[1].framework, 'gut');
  const plan = await f.call('godot.automation_plan');
  assert.equal(plan.manifestExists, true);
  assert.equal(plan.items.length, 3);
  assert.deepEqual((await f.call('browser-qa.manifest')).scenarios, []);
  assert.deepEqual((await f.call('automation.manifest_status')).sections, ['devmate.godot', 'devmate.godot-advanced']);

  // A second bootstrap merges into the existing manifest instead of failing on the path policy.
  const again = await f.call('godot.automation_bootstrap');
  assert.equal(again.changed, false);
  assert.equal(again.backupPath, null);
  const edited = f.readManifest();
  edited.plugins['devmate.godot'].scenarios = edited.plugins['devmate.godot'].scenarios.filter(item => item.id !== 'web-smoke');
  edited.plugins['devmate.godot'].scenarios.push({ id: 'mine', kind: 'native', scene: 'res://main.tscn', requiredCheckpoints: ['ready'] });
  fs.writeFileSync(f.manifestFile, JSON.stringify(edited));
  const merged = await f.call('godot.automation_bootstrap');
  assert.equal(merged.changed, true);
  assert.match(merged.backupPath, /^\.devmate\/automation\.json\.\d+\.bak$/);
  assert.deepEqual(f.readManifest().plugins['devmate.godot'].scenarios.map(item => item.id), ['native-smoke', 'mine', 'web-smoke']);

  // Saved scenarios run: each reaches the Godot executable and returns a structured report.
  const bridge = await f.call('godot.qa_bridge_install');
  assert.equal(bridge.after.current, true);
  const native = await f.call('godot.acceptance_run_saved', { scenarioId: 'native-smoke' });
  assert.equal(native.manifestPath, '.devmate/automation.json');
  assert.equal(native.report.ok, false);
  assert.equal(native.report.checks.processSucceeded, false, 'the stand-in executable rejects Godot arguments');
  assert.equal(native.report.reportPath, 'artifacts/godot-qa/native-smoke.json');
  const performance = await f.call('godot.advanced_run_saved', { scenarioId: 'performance-main' });
  assert.equal(performance.scenario.kind, 'performance');
  assert.equal(performance.result.headless, true);
  assert.equal(performance.result.process.exitCode !== 0, true);
  const tests = await f.call('godot.advanced_run_saved', { scenarioId: 'tests-gut' });
  assert.equal(tests.result.framework, 'gut');
  assert.equal(tests.result.reportPath, 'artifacts/godot-tests/gut.xml');
  const suite = await f.call('godot.acceptance_suite');
  assert.deepEqual([suite.ok, suite.requested, suite.completed, suite.stoppedEarly], [false, 3, 1, true]);
  const advancedSuite = await f.call('godot.advanced_suite', { stopOnFailure: false });
  assert.deepEqual([advancedSuite.requested, advancedSuite.completed], [2, 2]);
  const matrix = await f.call('godot.export_matrix', { manifestPath: '.devmate/automation.json' });
  assert.deepEqual([matrix.requested, matrix.completed, matrix.results[0].preset], [1, 1, 'Web']);
  const quality = await f.call('godot.quality_report');
  assert.equal(quality.summary.automation.items, 4);
  assert.equal(fs.existsSync(path.join(f.root, 'artifacts', 'godot-quality', 'report.json')), true);

  // Baselines live under .devmate/baselines/godot.
  fs.mkdirSync(path.join(f.root, 'artifacts', 'godot-performance'), { recursive: true });
  const samples = [1200, 1450, 1700, 1950].map(elapsed_ms => ({ elapsed_ms, fps: 60, process_ms: 4, physics_ms: 2, memory_static_bytes: 1000000, node_count: 10, orphan_node_count: 0, draw_calls: 20 }));
  fs.writeFileSync(path.join(f.root, 'artifacts', 'godot-performance', 'latest.json'),
    JSON.stringify({ runtime: { scene: 'res://main.tscn', engine_version: '4.4.stable' }, performance: { enabled: true, sample_interval_ms: 250, samples } }));
  const baseline = await f.call('godot.performance_baseline_update');
  assert.equal(baseline.baselinePath, '.devmate/baselines/godot/default.json');
  assert.equal(baseline.baseline.evaluatedSamples, 4);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, baseline.baselinePath), 'utf8')).metrics.fps_p50, 60);
  await assert.rejects(f.call('godot.performance_baseline_update'), /already exists.*force=true/);
  const replaced = await f.call('godot.performance_baseline_update', { force: true });
  assert.match(replaced.backupPath, /^\.devmate\/baselines\/godot\/default\.json\.\d+\.bak$/);
  const named = await f.call('godot.performance_baseline_update', { baselineId: 'release-1' });
  assert.equal(named.baselinePath, '.devmate/baselines/godot/release-1.json');
  // The regression run reads the baseline back before it starts Godot.
  const regression = await f.call('godot.performance_regression', { runForMs: 250 });
  assert.equal(regression.baseline.path, '.devmate/baselines/godot/default.json');
  assert.equal(regression.ok, false);
  assert.equal(regression.reportPath, 'artifacts/godot-performance/regression.json');
  await assert.rejects(f.call('godot.performance_regression', { baselineId: 'absent' }), error => error.code === 'not_found' && /\.devmate\/baselines\/godot\/absent\.json/.test(error.message));

  // The policy still protects everything else under .devmate.
  await assert.rejects(f.call('godot.performance_baseline_update', { baselinePath: '.devmate/state.json', force: true }), /protected/);
  await assert.rejects(f.call('browser-qa.manifest', { manifestPath: '.devmate/other.json' }), /protected/);
});

test('the manifest a bootstrap writes is one its own readers accept, for both test frameworks', { timeout: 60000 }, async t => {
  for (const framework of ['gut', 'gdunit4']) {
    const f = await fixture(t, { framework });
    const planned = await f.call('godot.automation_bootstrap', { dryRun: true });
    assert.equal(fs.existsSync(f.manifestFile), false, 'a dry run writes nothing');
    const written = await f.call('godot.automation_bootstrap');
    assert.deepEqual(written.manifest, planned.manifest);
    const manifest = f.readManifest();
    assert.deepEqual(Object.keys(manifest.plugins['devmate.godot']).sort(), ['exportMode', 'exportOutputRoot', 'exports', 'mode', 'outputPath', 'preset', 'projectSubpath', 'scenarios']);
    godotAutomationConfigSchema.parse(manifest.plugins['devmate.godot']);
    advancedAutomationConfigSchema.parse(manifest.plugins['devmate.godot-advanced']);
    const saved = manifest.plugins['devmate.godot-advanced'].scenarios.find(item => item.kind === 'tests');
    assert.deepEqual([saved.id, saved.framework, saved.reportPath], framework === 'gut'
      ? ['tests-gut', 'gut', 'artifacts/godot-tests/gut.xml'] : ['tests-gdunit4', 'gdunit4', 'artifacts/godot-tests/gdunit4']);
    assert.equal((await f.call('godot.advanced_manifest')).config.scenarios.length, 2);
    assert.equal((await f.call('godot.automation_manifest')).config.scenarios.length, 2);
    assert.equal((await f.call('godot.advanced_run_saved', { scenarioId: saved.id })).result.framework, framework);
  }
});

test('a manifest key no reader accepts is named, and bootstrap refuses to write over it', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.call('godot.automation_bootstrap');
  const manifest = f.readManifest();
  manifest.plugins['devmate.godot'].bootstrap = { generatedBy: 'DevMate' };
  manifest.plugins['devmate.godot-advanced'].scenarios.push({ id: 'legacy-tests', kind: 'gut' });
  const text = JSON.stringify(manifest);
  fs.writeFileSync(f.manifestFile, text);
  await assert.rejects(f.call('godot.automation_manifest'),
    error => error.code === 'invalid_manifest' && /\.devmate\/automation\.json is invalid: plugins\.devmate\.godot: Unrecognized key: "bootstrap"/.test(error.message));
  await assert.rejects(f.call('godot.advanced_manifest'), error => error.code === 'invalid_manifest' && /plugins\.devmate\.godot-advanced\.scenarios\.2/.test(error.message));
  await assert.rejects(f.call('godot.acceptance_suite'), error => error.code === 'invalid_manifest');
  await assert.rejects(f.call('godot.automation_bootstrap'), error => error.code === 'invalid_manifest');
  assert.equal(fs.readFileSync(f.manifestFile, 'utf8'), text, 'the manifest is left as it was');
});
