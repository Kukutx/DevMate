import { z } from 'zod';
import { loadAutomationManifest, pluginAutomationConfig, scenarioById } from './automation-manifest.mjs';
import { runMovieCapture, runPerformanceTest } from './godot-performance.mjs';
import { runGodotTests } from './godot-tests.mjs';

const assertionSchema = z.object({
  statePath: z.string().max(1000).default(''),
  operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'includes', 'truthy', 'falsy']).default('eq'),
  value: z.unknown().optional()
}).strict();

const inputActionSchema = z.object({
  atMs: z.number().int().min(0).max(300000),
  type: z.enum(['press', 'release', 'tap']).default('tap'),
  action: z.string().min(1).max(200),
  durationMs: z.number().int().min(1).max(30000).optional(),
  strength: z.number().min(0).max(1).optional()
}).strict();

const budgetSchema = z.object({
  minSamples: z.number().int().min(1).max(5000).optional(),
  minFpsP50: z.number().min(0).max(1000).optional(),
  minFpsP95: z.number().min(0).max(1000).optional(),
  maxProcessMsP95: z.number().min(0).max(10000).optional(),
  maxPhysicsMsP95: z.number().min(0).max(10000).optional(),
  maxMemoryBytes: z.number().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  maxNodeCount: z.number().min(0).max(10000000).optional(),
  maxOrphanNodeCount: z.number().min(0).max(10000000).optional(),
  maxDrawCallsP95: z.number().min(0).max(10000000).optional(),
  maxPhysics2dPairs: z.number().min(0).max(10000000).optional(),
  maxPhysics3dPairs: z.number().min(0).max(10000000).optional()
}).strict();

const nativeFields = {
  scene: z.string().max(1000).optional(),
  runForMs: z.number().int().min(250).max(300000).optional(),
  quitOnCheckpoint: z.string().max(200).optional(),
  inputActions: z.array(inputActionSchema).max(100).optional(),
  assertions: z.array(assertionSchema).max(100).optional(),
  requiredCheckpoints: z.array(z.string().min(1).max(200)).max(100).optional(),
  reportPath: z.string().max(1000).optional(),
  timeoutMs: z.number().int().min(1000).max(1800000).optional()
};

export const advancedScenarioSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
    description: z.string().max(1000).optional(),
    kind: z.literal('performance'),
    projectSubpath: z.string().max(1000).optional(),
    ...nativeFields,
    warmupMs: z.number().int().min(0).max(300000).optional(),
    sampleIntervalMs: z.number().int().min(50).max(5000).optional(),
    maxSamples: z.number().int().min(1).max(5000).optional(),
    budgets: budgetSchema.optional()
  }).strict(),
  z.object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
    description: z.string().max(1000).optional(),
    kind: z.literal('capture'),
    projectSubpath: z.string().max(1000).optional(),
    ...nativeFields,
    moviePath: z.string().max(1000).optional(),
    fps: z.number().int().min(1).max(120).optional(),
    frames: z.number().int().min(1).max(18000).optional(),
    disableVsync: z.boolean().optional(),
    performance: z.boolean().optional(),
    performanceBudgets: budgetSchema.optional()
  }).strict(),
  z.object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
    description: z.string().max(1000).optional(),
    kind: z.literal('tests'),
    projectSubpath: z.string().max(1000).optional(),
    framework: z.enum(['auto', 'gut', 'gdunit4']).optional(),
    directories: z.array(z.string().max(1000)).max(50).optional(),
    testScripts: z.array(z.string().max(1000)).max(100).optional(),
    ignore: z.array(z.string().max(1000)).max(100).optional(),
    select: z.string().max(200).optional(),
    testName: z.string().max(200).optional(),
    includeSubdirectories: z.boolean().optional(),
    continueAfterFailure: z.boolean().optional(),
    reportPath: z.string().max(1000).optional(),
    timeoutMs: z.number().int().min(1000).max(1800000).optional()
  }).strict()
]);

const configSchema = z.object({
  projectSubpath: z.string().max(1000).default('.'),
  scenarios: z.array(advancedScenarioSchema).max(100).default([])
}).strict();

export async function loadAdvancedAutomation(context, { workspaceId, manifestPath, required = true } = {}) {
  const loaded = await loadAutomationManifest(context, { workspaceId, manifestPath, required });
  if (!loaded.exists) return { ...loaded, config: null };
  const config = configSchema.parse(pluginAutomationConfig(loaded.manifest, 'devmate.godot-advanced'));
  const ids = new Set();
  for (const scenario of config.scenarios) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate advanced Godot scenario id: ${scenario.id}`);
    ids.add(scenario.id);
  }
  return { ...loaded, config };
}

function scenarioArguments(config, scenario) {
  const { id, description, kind, ...args } = scenario;
  return { projectSubpath: scenario.projectSubpath || config.projectSubpath, ...args };
}

export async function runAdvancedScenario(context, { workspaceId, manifestPath, scenarioId } = {}) {
  const loaded = await loadAdvancedAutomation(context, { workspaceId, manifestPath });
  const scenario = advancedScenarioSchema.parse(scenarioById(loaded.config.scenarios, scenarioId));
  const args = { workspaceId, ...scenarioArguments(loaded.config, scenario) };
  const result = scenario.kind === 'performance'
    ? await runPerformanceTest(context, args)
    : scenario.kind === 'capture'
      ? await runMovieCapture(context, args)
      : await runGodotTests(context, args);
  return { manifestPath: loaded.manifestPath, scenario, result };
}

export async function runAdvancedSuite(context, {
  workspaceId,
  manifestPath,
  scenarioIds = [],
  stopOnFailure = true
} = {}) {
  const loaded = await loadAdvancedAutomation(context, { workspaceId, manifestPath });
  const selected = scenarioIds.length
    ? scenarioIds.map(id => advancedScenarioSchema.parse(scenarioById(loaded.config.scenarios, id)))
    : loaded.config.scenarios;
  if (!selected.length) throw new Error('No advanced Godot scenarios are configured');
  const results = [];
  for (const scenario of selected) {
    const executed = await runAdvancedScenario(context, { workspaceId, manifestPath, scenarioId: scenario.id });
    results.push({ id: scenario.id, kind: scenario.kind, description: scenario.description || '', result: executed.result });
    if (!executed.result.ok && stopOnFailure) break;
  }
  const passed = results.filter(item => item.result.ok).length;
  return {
    ok: passed === selected.length && results.length === selected.length,
    manifestPath: loaded.manifestPath,
    requested: selected.length,
    completed: results.length,
    passed,
    failed: results.length - passed,
    stoppedEarly: results.length < selected.length,
    results
  };
}

export const __test = { configSchema, scenarioArguments };
