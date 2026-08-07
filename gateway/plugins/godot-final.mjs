import { z } from 'zod';
import { extendPlugin } from './plugin-sdk.mjs';
import { advancedGodotPlugin } from './godot-advanced.mjs';
import { runAcceptanceScenario, runAcceptanceSuite } from './godot-acceptance.mjs';
import { loadAutomationManifest, pluginAutomationConfig } from './automation-manifest.mjs';
import { runAdvancedScenario } from './godot-advanced-automation.mjs';
import { runExportMatrix } from './godot-export-matrix.mjs';
import { runQualityGate } from './godot-quality.mjs';
import { runReleaseReadiness } from './godot-release.mjs';

const budgetSchema = z.object({
  minSamples: z.number().int().min(1).max(5000).optional(),
  minFpsP05: z.number().min(0).max(1000).optional(),
  minFpsP50: z.number().min(0).max(1000).optional(),
  maxProcessMsP95: z.number().min(0).max(10000).optional(),
  maxPhysicsMsP95: z.number().min(0).max(10000).optional(),
  maxMemoryBytes: z.number().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  maxNodeCount: z.number().min(0).max(10000000).optional(),
  maxOrphanNodeCount: z.number().min(0).max(10000000).optional(),
  maxDrawCallsP95: z.number().min(0).max(10000000).optional(),
  maxPhysics2dPairs: z.number().min(0).max(10000000).optional(),
  maxPhysics3dPairs: z.number().min(0).max(10000000).optional()
}).strict();

const finalConfigSchema = z.object({
  projectSubpath: z.string().max(1000).default('.'),
  acceptanceScenarioIds: z.array(z.string().min(1).max(100)).max(100).default([]),
  advancedScenarioIds: z.array(z.string().min(1).max(100)).max(100).default([]),
  exportPresets: z.array(z.string().min(1).max(200)).max(100).default([]),
  quality: z.object({
    requireExportPresets: z.boolean().default(true),
    requireAcceptance: z.boolean().default(false),
    requireAdvanced: z.boolean().default(false),
    requireExports: z.boolean().default(false),
    maxErrors: z.number().int().min(0).max(100000).default(0),
    maxWarnings: z.number().int().min(0).max(100000).default(100),
    performanceBudgets: budgetSchema.optional()
  }).strict().default({})
}).strict();

async function loadFinalConfig(context, { workspaceId, manifestPath, required = true } = {}) {
  const loaded = await loadAutomationManifest(context, { workspaceId, manifestPath, required });
  if (!loaded.exists) return { ...loaded, config: null };
  const config = finalConfigSchema.parse(pluginAutomationConfig(loaded.manifest, 'devmate.godot-final'));
  return { ...loaded, config };
}

async function runNamedAdvancedScenarios(context, { workspaceId, manifestPath, scenarioIds = [] } = {}) {
  const results = [];
  for (const scenarioId of scenarioIds) {
    const executed = await runAdvancedScenario(context, { workspaceId, manifestPath, scenarioId });
    results.push({ id: scenarioId, kind: executed.scenario.kind, ok: executed.result.ok, result: executed.result });
  }
  return results;
}

function summary(items = []) {
  return {
    total: items.length,
    passed: items.filter(item => item.ok).length,
    failed: items.filter(item => !item.ok).length,
    ok: items.every(item => item.ok)
  };
}

export async function runFinalValidation(context, {
  workspaceId,
  manifestPath,
  stopOnFailure = true
} = {}) {
  const loaded = await loadFinalConfig(context, { workspaceId, manifestPath });
  const config = loaded.config;
  const acceptance = [];
  for (const scenarioId of config.acceptanceScenarioIds) {
    const executed = await runAcceptanceScenario(context, { workspaceId, manifestPath, scenarioId });
    acceptance.push({ id: scenarioId, ok: executed.result.ok, result: executed.result });
    if (!executed.result.ok && stopOnFailure) break;
  }
  const acceptanceSummary = summary(acceptance);
  if (!acceptanceSummary.ok && stopOnFailure) {
    return {
      ok: false,
      manifestPath: loaded.manifestPath,
      acceptance: { ...acceptanceSummary, results: acceptance },
      advanced: { total: 0, passed: 0, failed: 0, ok: true, results: [] },
      exports: null,
      quality: null
    };
  }

  const advanced = await runNamedAdvancedScenarios(context, {
    workspaceId,
    manifestPath,
    scenarioIds: config.advancedScenarioIds
  });
  const advancedSummary = summary(advanced);
  if (!advancedSummary.ok && stopOnFailure) {
    return {
      ok: false,
      manifestPath: loaded.manifestPath,
      acceptance: { ...acceptanceSummary, results: acceptance },
      advanced: { ...advancedSummary, results: advanced },
      exports: null,
      quality: null
    };
  }

  const exports = config.exportPresets.length
    ? await runExportMatrix(context, {
      workspaceId,
      projectSubpath: config.projectSubpath,
      presets: config.exportPresets,
      continueOnError: !stopOnFailure
    })
    : null;
  if (exports && !exports.ok && stopOnFailure) {
    return {
      ok: false,
      manifestPath: loaded.manifestPath,
      acceptance: { ...acceptanceSummary, results: acceptance },
      advanced: { ...advancedSummary, results: advanced },
      exports,
      quality: null
    };
  }

  const quality = await runQualityGate(context, {
    workspaceId,
    projectSubpath: config.projectSubpath,
    requireExportPresets: config.quality.requireExportPresets,
    maxErrors: config.quality.maxErrors,
    maxWarnings: config.quality.maxWarnings
  });
  const ok = acceptanceSummary.ok && advancedSummary.ok && (!exports || exports.ok) && quality.ok;
  return {
    ok,
    manifestPath: loaded.manifestPath,
    acceptance: { ...acceptanceSummary, results: acceptance },
    advanced: { ...advancedSummary, results: advanced },
    exports,
    quality
  };
}

export const finalGodotPlugin = extendPlugin(advancedGodotPlugin, {
  version: '0.8.0',
  description: 'Production-grade Godot development with saved validation suites, cross-platform export validation, quality gates, and release-readiness orchestration.',
  capabilities: ['final-validation', 'quality-gates', 'export-matrix', 'release-readiness'],
  async activate(context) {
    const { server } = context;

    server.registerTool('godot_final_manifest', {
      title: 'Godot final validation manifest',
      description: 'Read and validate version-controlled final validation settings from the devmate.godot-final automation namespace.',
      inputSchema: { workspaceId: z.string().optional(), manifestPath: z.string().max(1000).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async args => {
      const loaded = await loadFinalConfig(context, { ...args, required: false });
      return context.toolText({ workspace: loaded.workspace, manifestPath: loaded.manifestPath, exists: loaded.exists, config: loaded.config });
    });

    server.registerTool('godot_final_validate', {
      title: 'Run final Godot validation',
      description: 'Run configured acceptance, advanced, export, and quality checks as one production-readiness validation pass.',
      inputSchema: {
        workspaceId: z.string().optional(),
        manifestPath: z.string().max(1000).optional(),
        stopOnFailure: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async args => {
      const result = await runFinalValidation(context, args);
      await context.audit('final_validation', {
        workspace: args.workspaceId || null,
        ok: result.ok,
        acceptanceFailed: result.acceptance.failed,
        advancedFailed: result.advanced.failed,
        exportFailed: result.exports?.failed || 0,
        qualityOk: result.quality?.ok ?? null
      });
      return context.toolText(result);
    });

    server.registerTool('godot_release_readiness', {
      title: 'Godot release readiness',
      description: 'Run production release-readiness checks with version, export, acceptance, advanced, and quality requirements.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().max(1000).optional(),
        manifestPath: z.string().max(1000).optional(),
        version: z.string().max(100).optional(),
        versionFile: z.string().max(1000).optional(),
        requireVersion: z.boolean().optional(),
        requireExportPresets: z.boolean().optional(),
        requireAcceptance: z.boolean().optional(),
        requireAdvanced: z.boolean().optional(),
        requireExports: z.boolean().optional(),
        acceptanceScenarioIds: z.array(z.string().min(1).max(100)).max(100).optional(),
        advancedScenarioIds: z.array(z.string().min(1).max(100)).max(100).optional(),
        exportPresets: z.array(z.string().min(1).max(200)).max(100).optional(),
        maxErrors: z.number().int().min(0).max(100000).optional(),
        maxWarnings: z.number().int().min(0).max(100000).optional(),
        performanceBudgets: budgetSchema.optional(),
        outputPath: z.string().max(1000).optional(),
        timeoutMs: z.number().int().min(1000).max(1800000).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async args => {
      const result = await runReleaseReadiness(context, args);
      await context.audit('release_readiness', {
        workspace: result.workspace.id,
        ok: result.ok,
        version: result.version?.value || null,
        releaseReportPath: result.releaseReportPath
      });
      return context.toolText(result);
    });
  }
});

export const __test = { finalConfigSchema, loadFinalConfig, runNamedAdvancedScenarios, summary };
