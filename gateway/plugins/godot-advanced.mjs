import { z } from 'zod';
import { definePlugin } from './plugin-sdk.mjs';
import { enhancedGodotPlugin } from './godot-enhanced.mjs';
import { runMovieCapture, runPerformanceTest } from './godot-performance.mjs';
import { inspectGodotTests, runGodotTests } from './godot-tests.mjs';

const inputActionSchema = z.object({
  atMs: z.number().int().min(0).max(300000),
  type: z.enum(['press', 'release', 'tap']).default('tap'),
  action: z.string().min(1).max(200),
  durationMs: z.number().int().min(1).max(30000).optional(),
  strength: z.number().min(0).max(1).optional()
}).strict();

const assertionSchema = z.object({
  statePath: z.string().max(1000).default(''),
  operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'includes', 'truthy', 'falsy']).default('eq'),
  value: z.unknown().optional()
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

const nativeBaseSchema = {
  workspaceId: z.string().optional(),
  projectSubpath: z.string().max(1000).optional(),
  scene: z.string().max(1000).optional(),
  headless: z.boolean().optional(),
  runForMs: z.number().int().min(250).max(300000).optional(),
  quitOnCheckpoint: z.string().max(200).optional(),
  inputActions: z.array(inputActionSchema).max(100).optional(),
  assertions: z.array(assertionSchema).max(100).optional(),
  requiredCheckpoints: z.array(z.string().min(1).max(200)).max(100).optional(),
  reportPath: z.string().max(1000).optional(),
  timeoutMs: z.number().int().min(1000).max(900000).optional()
};

export const advancedGodotPlugin = definePlugin({
  manifest: {
    ...enhancedGodotPlugin.manifest,
    version: '0.5.0',
    description: 'Godot development with runtime verification, native/Web acceptance, performance budgets, deterministic movie capture, framework tests, quality reports, and multi-platform exports.',
    capabilities: [...new Set([
      ...enhancedGodotPlugin.manifest.capabilities,
      'performance-budgets', 'movie-capture', 'test-frameworks', 'junit'
    ])]
  },
  settingsSchema: enhancedGodotPlugin.settingsSchema,
  defaultSettings: enhancedGodotPlugin.defaultSettings,
  diagnose: enhancedGodotPlugin.diagnose,
  async activate(context) {
    await enhancedGodotPlugin.activate(context);
    const { server } = context;

    server.registerTool('godot_performance_test', {
      title: 'Run Godot performance test',
      description: 'Run native/headless QA with bounded Godot Performance samples, warmup filtering, percentile summaries, and explicit performance budgets.',
      inputSchema: {
        ...nativeBaseSchema,
        warmupMs: z.number().int().min(0).max(300000).optional(),
        sampleIntervalMs: z.number().int().min(50).max(5000).optional(),
        maxSamples: z.number().int().min(1).max(5000).optional(),
        budgets: budgetSchema.optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async args => {
      const result = await runPerformanceTest(context, args);
      await context.audit('performance_test', {
        workspace: result.workspace.id,
        projectSubpath: result.projectSubpath,
        scene: result.scene,
        ok: result.ok,
        samples: result.performance.summary.evaluatedSamples,
        failedBudgets: result.performance.budget.failed,
        reportPath: result.reportPath
      });
      return context.toolText(result);
    });

    server.registerTool('godot_movie_capture', {
      title: 'Capture deterministic Godot movie',
      description: 'Run a Godot scene through Movie Maker mode with fixed FPS, bounded frame count, optional Input replay, QA assertions, and an AVI artifact.',
      inputSchema: {
        ...nativeBaseSchema,
        moviePath: z.string().max(1000).optional(),
        fps: z.number().int().min(1).max(120).optional(),
        frames: z.number().int().min(1).max(18000).optional(),
        disableVsync: z.boolean().optional(),
        performance: z.boolean().optional(),
        performanceBudgets: budgetSchema.optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async args => {
      const result = await runMovieCapture(context, args);
      await context.audit('movie_capture', {
        workspace: result.workspace.id,
        projectSubpath: result.projectSubpath,
        scene: result.scene,
        ok: result.ok,
        moviePath: result.capture?.path,
        bytes: result.capture?.bytes || 0
      });
      return context.toolText(result);
    });

    server.registerTool('godot_test_status', {
      title: 'Godot test framework status',
      description: 'Detect GUT and GdUnit4 installations and list a bounded set of likely GDScript test files without executing tests.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().max(1000).optional(),
        maxFiles: z.number().int().min(100).max(10000).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async args => context.toolText(await inspectGodotTests(context, args)));

    server.registerTool('godot_test_run', {
      title: 'Run Godot framework tests',
      description: 'Run installed GUT or GdUnit4 tests with bounded paths, structured diagnostics, JUnit parsing, and workspace-contained reports.',
      inputSchema: {
        workspaceId: z.string().optional(),
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
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async args => {
      const result = await runGodotTests(context, args);
      await context.audit('test_run', {
        workspace: result.workspace.id,
        projectSubpath: result.projectSubpath,
        framework: result.framework,
        ok: result.ok,
        tests: result.junit?.tests ?? null,
        failures: result.junit?.failures ?? null,
        reportPath: result.reportPath
      });
      return context.toolText(result);
    });
  }
});
