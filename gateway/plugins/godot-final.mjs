import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { definePlugin } from './plugin-sdk.mjs';
import { advancedGodotPlugin } from './godot-advanced.mjs';
import { bootstrapGodotAutomation } from './godot-bootstrap.mjs';
import { comparePerformanceBaseline, readPerformanceBaseline, writePerformanceBaseline } from './godot-baseline.mjs';
import { compactPerformanceResult, runPerformanceTest } from './godot-performance.mjs';
import { evaluateGodotReleaseGate } from './godot-release-gate.mjs';

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
  minFpsP05: z.number().min(0).max(1000).optional(),
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

const nativeSchema = {
  workspaceId: z.string().optional(),
  projectSubpath: z.string().max(1000).optional(),
  scene: z.string().max(1000).optional(),
  headless: z.boolean().optional(),
  runForMs: z.number().int().min(250).max(300000).optional(),
  quitOnCheckpoint: z.string().max(200).optional(),
  inputActions: z.array(inputActionSchema).max(100).optional(),
  assertions: z.array(assertionSchema).max(100).optional(),
  requiredCheckpoints: z.array(z.string().min(1).max(200)).max(100).optional(),
  timeoutMs: z.number().int().min(1000).max(900000).optional(),
  warmupMs: z.number().int().min(0).max(300000).optional(),
  sampleIntervalMs: z.number().int().min(50).max(5000).optional(),
  maxSamples: z.number().int().min(1).max(5000).optional(),
  budgets: budgetSchema.optional()
};

async function writeRegressionReport(context, result, relativePath) {
  const workspace = context.workspace.get(result.workspace.id, { writable: true });
  const relative = String(relativePath || 'artifacts/godot-performance/regression.json').trim().replace(/\\/g, '/');
  if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Godot performance regression report must stay inside the workspace');
  const file = context.workspace.resolve(workspace, path.join(result.projectSubpath || '.', relative));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, file);
  return path.relative(workspace.root, file).replace(/\\/g, '/');
}

export const finalGodotPlugin = definePlugin({
  manifest: {
    ...advancedGodotPlugin.manifest,
    version: '0.6.0',
    description: 'Mature Godot development gateway with runtime verification, audits, deterministic QA, tests, performance baselines and regressions, release evidence gates, capture, exports, and durable Runner workflows.',
    capabilities: [...new Set([
      ...advancedGodotPlugin.manifest.capabilities,
      'performance-baselines', 'performance-regression', 'automation-bootstrap', 'release-gate'
    ])]
  },
  settingsSchema: advancedGodotPlugin.settingsSchema,
  defaultSettings: advancedGodotPlugin.defaultSettings,
  diagnose: advancedGodotPlugin.diagnose,
  async activate(context) {
    await advancedGodotPlugin.activate(context);
    const { server } = context;

    server.registerTool('godot_performance_baseline_update', {
      title: 'Update Godot performance baseline',
      description: 'Create or deliberately replace a versioned performance baseline from an existing native performance report.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().max(1000).optional(),
        baselineId: z.string().max(100).optional(),
        reportPath: z.string().max(1000).optional(),
        baselinePath: z.string().max(1000).optional(),
        warmupMs: z.number().int().min(0).max(300000).optional(),
        force: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    }, async args => {
      context.assertCanMutate('Updating Godot performance baseline');
      const result = await writePerformanceBaseline(context, args);
      await context.audit('performance_baseline_update', { workspace: result.workspace.id, projectSubpath: result.projectSubpath, baselinePath: result.baselinePath, baselineId: result.baseline.id, replaced: !!result.backupPath });
      return context.toolText({ ...result, artifactPaths: [result.baselinePath] });
    });

    server.registerTool('godot_performance_regression', {
      title: 'Run Godot performance regression',
      description: 'Run a fresh native performance test and compare stable metric points against a reviewed project baseline.',
      inputSchema: {
        ...nativeSchema,
        baselineId: z.string().max(100).optional(),
        baselinePath: z.string().max(1000).optional(),
        maxRegressionPercent: z.number().min(0).max(1000).optional(),
        minSamplesRatio: z.number().min(0.1).max(1).optional(),
        metricThresholds: z.record(z.string(), z.number().min(0).max(1000)).optional(),
        reportPath: z.string().max(1000).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async args => {
      const { baselineId, baselinePath, maxRegressionPercent, minSamplesRatio, metricThresholds, reportPath, ...performanceArgs } = args;
      const loaded = await readPerformanceBaseline(context, { workspaceId: args.workspaceId, projectSubpath: args.projectSubpath, baselineId, baselinePath });
      const performance = await runPerformanceTest(context, {
        ...performanceArgs,
        reportPath: reportPath || 'artifacts/godot-performance/regression-run.json'
      });
      const regression = comparePerformanceBaseline(performance.performance.summary, loaded.baseline, { maxRegressionPercent, minSamplesRatio, metricThresholds });
      const result = {
        ...compactPerformanceResult(performance),
        ok: performance.ok && regression.ok,
        baseline: { path: loaded.relative, id: loaded.baseline.id, createdAt: loaded.baseline.createdAt, scene: loaded.baseline.scene },
        regression
      };
      const evidencePath = await writeRegressionReport(context, result, 'artifacts/godot-performance/regression.json');
      result.reportPath = evidencePath;
      result.artifactPaths = [...new Set([...(result.artifactPaths || []), evidencePath])];
      await context.audit('performance_regression', { workspace: result.workspace.id, projectSubpath: result.projectSubpath, ok: result.ok, baselineId: loaded.baseline.id, failed: regression.failed, reportPath: evidencePath });
      return context.toolText(result);
    });

    server.registerTool('godot_automation_bootstrap', {
      title: 'Bootstrap Godot automation manifest',
      description: 'Safely create or merge reviewed native/Web/export/performance/test starter scenarios from the current project without replacing existing scenario ids.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().max(1000).optional(),
        manifestPath: z.string().max(1000).optional(),
        includeAdvanced: z.boolean().optional(),
        merge: z.boolean().optional(),
        dryRun: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    }, async args => {
      if (!args.dryRun) context.assertCanMutate('Bootstrapping Godot automation');
      const result = await bootstrapGodotAutomation(context, args);
      if (!args.dryRun) await context.audit('automation_bootstrap', { workspace: result.workspace.id, projectSubpath: result.projectSubpath, manifestPath: result.manifestPath, changed: result.changed, backupPath: result.backupPath });
      return context.toolText({ ...result, artifactPaths: args.dryRun ? [] : [result.manifestPath] });
    });

    server.registerTool('godot_release_gate', {
      title: 'Evaluate Godot release gate',
      description: 'Evaluate fresh quality, framework-test, performance, export, and optional capture evidence against an explicit release policy and write a final JSON decision artifact.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().max(1000).optional(),
        evidence: z.array(z.object({
          type: z.enum(['quality', 'tests', 'performance', 'exports', 'capture']),
          path: z.string().min(1).max(1000)
        }).strict()).max(50),
        policy: z.object({
          maxAgeHours: z.number().min(0).max(8760).optional(),
          maxAuditErrors: z.number().int().min(0).max(100000).optional(),
          maxAuditWarnings: z.number().int().min(0).max(100000).optional(),
          maxMissingDependencies: z.number().int().min(0).max(100000).optional(),
          maxBlockedAutomation: z.number().int().min(0).max(100000).optional(),
          requiredTypes: z.array(z.enum(['quality', 'tests', 'performance', 'exports', 'capture'])).max(5).optional()
        }).strict().optional(),
        reportPath: z.string().max(1000).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    }, async args => {
      const result = await evaluateGodotReleaseGate(context, args);
      await context.audit('release_gate', { workspace: result.workspace.id, projectSubpath: result.projectSubpath, ok: result.ok, blockers: result.blockers.length, warnings: result.warnings.length, reportPath: result.reportPath });
      return context.toolText(result);
    });
  }
});

export const __test = { writeRegressionReport };
