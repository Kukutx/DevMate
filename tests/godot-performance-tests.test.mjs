import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { advancedScenarioSchema, loadAdvancedAutomation, runAdvancedSuite } from '../gateway/plugins/godot-advanced-automation.mjs';
import { evaluatePerformanceBudgets, percentile, runMovieCapture, runPerformanceTest, summarizePerformance } from '../gateway/plugins/godot-performance.mjs';
import { inspectGodotTests, parseJunitXml, runGodotTests, __test as testAdapterTest } from '../gateway/plugins/godot-tests.mjs';
import { installQaBridge, inspectQaBridge, __test as bridgeTest } from '../gateway/plugins/godot-qa-bridge.mjs';

function contextFor(root, run) {
  const workspace = { id: 'game', name: 'game', root, mode: 'workspace-write', reference: false };
  return {
    settings: { executablePath: '', defaultProjectSubpath: '.', validationTimeoutMs: 10000, exportTimeoutMs: 10000 },
    workspace: {
      get() { return workspace; },
      resolve(_workspace, subpath) {
        const target = path.resolve(root, subpath || '.');
        const relative = path.relative(root, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('escape');
        return target;
      }
    },
    executables: {
      find(candidates = []) { return candidates.includes('dotnet') ? null : 'godot'; },
      assertAllowed(value) { return value; },
      run
    }
  };
}

async function createProject() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-godot-perf-'));
  await fsp.writeFile(path.join(root, 'project.godot'), `config_version=5\n\n[application]\nconfig/name="Performance Fixture"\nrun/main_scene="res://main.tscn"\n\n[input]\nattack={\n"deadzone": 0.5,\n"events": []\n}\n`, 'utf8');
  await fsp.writeFile(path.join(root, 'main.tscn'), '[gd_scene format=3]\n[node name="Main" type="Node"]\n', 'utf8');
  return root;
}

function performanceReport() {
  return {
    runtime: { bridge_ready: true, bridge_version: 3, completed: true, ok: true },
    checkpoints: [],
    performance: {
      enabled: true,
      sample_interval_ms: 100,
      samples: [
        { elapsed_ms: 0, fps: 0, process_ms: 0, physics_ms: 0, memory_static_bytes: 100, node_count: 2, orphan_node_count: 0, draw_calls: 0 },
        { elapsed_ms: 1000, fps: 60, process_ms: 5, physics_ms: 2, memory_static_bytes: 120, node_count: 4, orphan_node_count: 0, draw_calls: 8 },
        { elapsed_ms: 1100, fps: 58, process_ms: 7, physics_ms: 3, memory_static_bytes: 140, node_count: 5, orphan_node_count: 1, draw_calls: 10 },
        { elapsed_ms: 1200, fps: 62, process_ms: 4, physics_ms: 2, memory_static_bytes: 130, node_count: 4, orphan_node_count: 0, draw_calls: 9 }
      ]
    }
  };
}

test('summarizes performance percentiles and evaluates only current budgets', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  const summary = summarizePerformance(performanceReport(), { warmupMs: 1000 });
  assert.equal(summary.evaluatedSamples, 3);
  assert.equal(summary.metrics.fps.min, 58);
  assert.equal(summary.metrics.fps.p05 >= 58, true);
  const budget = evaluatePerformanceBudgets(summary, { minSamples: 3, minFpsP05: 58, maxProcessMsP95: 7, maxNodeCount: 5, maxOrphanNodeCount: 0 });
  assert.equal(budget.configured, 5);
  assert.equal(budget.failed, 1);
  assert.equal(budget.results.find(item => item.field === 'maxOrphanNodeCount').passed, false);
  assert.throws(
    () => evaluatePerformanceBudgets(summary, { minFpsP95: 60 }),
    /Unknown Godot performance budget: minFpsP95/
  );
  assert.throws(
    () => advancedScenarioSchema.parse({ id: 'legacy-budget', kind: 'performance', budgets: { minFpsP95: 60 } }),
    /minFpsP95|Unrecognized key/
  );
});

test('parses bounded JUnit reports', () => {
  const parsed = parseJunitXml('<?xml version="1.0"?><testsuites><testsuite name="unit" tests="4" failures="1" errors="0" skipped="1" time="0.5"></testsuite></testsuites>');
  assert.equal(parsed.valid, true);
  assert.equal(parsed.tests, 4);
  assert.equal(parsed.failures, 1);
  assert.equal(parsed.skipped, 1);
});

test('detects GUT and builds constrained command arguments', async t => {
  const root = await createProject();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'addons', 'gut'), { recursive: true });
  await fsp.mkdir(path.join(root, 'tests'), { recursive: true });
  await fsp.writeFile(path.join(root, 'addons', 'gut', 'gut_cmdln.gd'), 'extends SceneTree\n', 'utf8');
  await fsp.writeFile(path.join(root, 'addons', 'gut', 'plugin.cfg'), '[plugin]\nversion="9.7.1"\n', 'utf8');
  await fsp.writeFile(path.join(root, 'tests', 'test_example.gd'), 'extends Node\n', 'utf8');
  const context = contextFor(root, async (_executable, args) => {
    const junitArg = args.find(value => String(value).startsWith('-gjunit_xml_file='));
    const junit = junitArg.slice('-gjunit_xml_file='.length);
    await fsp.mkdir(path.dirname(junit), { recursive: true });
    await fsp.writeFile(junit, '<testsuites><testsuite name="gut" tests="2" failures="0" errors="0" skipped="0" time="0.1"></testsuite></testsuites>', 'utf8');
    return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
  });
  const status = await inspectGodotTests(context, {});
  assert.deepEqual(status.detected, ['gut']);
  assert.equal(status.frameworks.gut.version, '9.7.1');
  const result = await runGodotTests(context, { framework: 'gut', directories: ['tests'] });
  assert.equal(result.ok, true);
  assert.equal(result.junit.tests, 2);
  assert.equal(result.args.includes('-gexit'), true);
  assert.throws(() => testAdapterTest.toResourcePath('../outside'), /inside/);
  const gdunitArgs = testAdapterTest.buildGdUnitArgs({ root }, { directories: ['tests'], ignore: [], continueAfterFailure: true, reportDirectory: 'artifacts/gdunit' });
  assert.equal(gdunitArgs.includes('res://addons/gdUnit4/bin/GdUnitCmdTool.gd'), true);
  assert.equal(gdunitArgs.includes('-rd'), true);
});

test('runs performance and movie capture through native QA contracts', async t => {
  const root = await createProject();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const context = contextFor(root, async (_executable, args, options = {}) => {
    const report = options.environment.DEVMATE_QA_REPORT;
    await fsp.mkdir(path.dirname(report), { recursive: true });
    await fsp.writeFile(report, JSON.stringify(performanceReport()), 'utf8');
    const movieIndex = args.indexOf('--write-movie');
    if (movieIndex >= 0) {
      const movie = args[movieIndex + 1];
      await fsp.mkdir(path.dirname(movie), { recursive: true });
      await fsp.writeFile(movie, Buffer.alloc(1024));
    }
    return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
  });
  await installQaBridge(context, {});
  const bridge = await inspectQaBridge(root);
  assert.equal(bridge.version, 3);
  assert.match(bridgeTest.QA_BRIDGE_SCRIPT, /Performance\.TIME_PROCESS/);
  const performance = await runPerformanceTest(context, { warmupMs: 1000, budgets: { minSamples: 3, maxNodeCount: 5 } });
  assert.equal(performance.ok, true);
  const capture = await runMovieCapture(context, { scene: 'res://main.tscn', frames: 30, fps: 30 });
  assert.equal(capture.ok, true);
  assert.equal(capture.capture.exists, true);
  assert.equal(capture.capture.bytes, 1024);
  assert.equal(capture.args.includes('--fixed-fps'), true);
});

test('loads and executes version-controlled advanced Godot suites', async t => {
  const root = await createProject();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, '.devmate'), { recursive: true });
  await fsp.writeFile(path.join(root, '.devmate', 'automation.json'), JSON.stringify({
    schemaVersion: 1,
    plugins: {
      'devmate.godot-advanced': {
        projectSubpath: '.',
        scenarios: [{
          id: 'performance-smoke',
          kind: 'performance',
          runForMs: 2000,
          warmupMs: 1000,
          budgets: { minSamples: 3, minFpsP05: 58, maxNodeCount: 5 }
        }]
      }
    }
  }, null, 2), 'utf8');
  const context = contextFor(root, async (_executable, _args, options = {}) => {
    await fsp.mkdir(path.dirname(options.environment.DEVMATE_QA_REPORT), { recursive: true });
    await fsp.writeFile(options.environment.DEVMATE_QA_REPORT, JSON.stringify(performanceReport()), 'utf8');
    return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
  });
  await installQaBridge(context, {});
  const manifest = await loadAdvancedAutomation(context, {});
  assert.equal(manifest.config.scenarios[0].kind, 'performance');
  const suite = await runAdvancedSuite(context, {});
  assert.equal(suite.ok, true);
  assert.equal(suite.results[0].result.performance.summary.evaluatedSamples, 3);
  assert.equal(Object.hasOwn(suite.results[0].result, 'report'), false);
});
