import { z } from 'zod';
import { definePlugin } from './plugin-sdk.mjs';
import { godotPlugin } from './godot.mjs';
import { buildGodotDependencyGraph } from './godot-graph.mjs';
import { installQaBridge } from './godot-qa-bridge.mjs';
import { planGodotAutomation } from './godot-plan.mjs';
import { writeGodotQualityReport } from './godot-report.mjs';
import { inspectGodotRuntime } from './godot-runtime.mjs';
import { resolveProject } from './godot-project.mjs';

function configureGodot(context, {
  workspaceId,
  projectSubpath,
  executablePath,
  defaultWebPreset,
  defaultWebOutput,
  defaultExportRoot,
  installBridge = false
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const config = context.readConfig();
  config.plugins ||= { enabled: [], settings: {} };
  if (!Array.isArray(config.plugins.enabled)) config.plugins.enabled = [];
  if (!config.plugins.enabled.includes('devmate.godot')) config.plugins.enabled.push('devmate.godot');
  config.plugins.settings ||= {};
  const settings = { ...(config.plugins.settings['devmate.godot'] || {}) };
  if (executablePath !== undefined) {
    const raw = String(executablePath || '').trim();
    if (raw) {
      const resolved = context.executables.find([raw]);
      if (!resolved) throw new Error(`Godot executable not found: ${raw}`);
      context.executables.assertAllowed(resolved);
      settings.executablePath = resolved;
    } else settings.executablePath = '';
  }
  settings.defaultProjectSubpath = project.subpath;
  if (defaultWebPreset !== undefined) settings.defaultWebPreset = String(defaultWebPreset || '').trim();
  if (defaultWebOutput !== undefined) settings.defaultWebOutput = String(defaultWebOutput || '').trim();
  if (defaultExportRoot !== undefined) settings.defaultExportRoot = String(defaultExportRoot || '').trim();
  config.plugins.settings['devmate.godot'] = settings;
  context.writeConfig(config);
  return { project, settings, installBridge };
}

export const enhancedGodotPlugin = definePlugin({
  manifest: {
    ...godotPlugin.manifest,
    version: '0.4.0',
    description: 'Godot project development, runtime verification, dependency analysis, native/Web acceptance, execution planning, quality reports, and multi-platform export orchestration.',
    capabilities: [...new Set([
      ...godotPlugin.manifest.capabilities,
      'runtime-inspection', 'dependency-graph', 'execution-planning', 'quality-report'
    ])]
  },
  settingsSchema: godotPlugin.settingsSchema,
  defaultSettings: godotPlugin.defaultSettings,
  async diagnose(context) {
    const base = godotPlugin.diagnose ? await godotPlugin.diagnose(context) : null;
    let runtime = null;
    try { runtime = await inspectGodotRuntime(context); }
    catch (error) { runtime = { ok: false, error: error.message || String(error) }; }
    return { ...base, runtime };
  },
  async activate(context) {
    await godotPlugin.activate(context);
    const { server } = context;

    server.registerTool('godot_runtime_status', {
      title: 'Godot runtime status',
      description: 'Inspect the configured Godot version, Standard/Mono build, matching export templates, .NET readiness, and host capability labels.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().optional(),
        timeoutMs: z.number().int().min(1000).max(60000).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    }, async args => context.toolText(await inspectGodotRuntime(context, args)));

    server.registerTool('godot_dependency_graph', {
      title: 'Godot dependency graph',
      description: 'Build a bounded scene/resource/script dependency graph with missing references, cycles, reverse dependencies, and scene node summaries.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().optional(),
        entryPaths: z.array(z.string().max(1000)).max(100).optional(),
        includeAllScenes: z.boolean().optional(),
        reverseTarget: z.string().max(1000).optional(),
        maxNodes: z.number().int().min(1).max(5000).optional(),
        maxDepth: z.number().int().min(0).max(100).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async args => context.toolText(await buildGodotDependencyGraph(context, args)));

    server.registerTool('godot_automation_plan', {
      title: 'Plan Godot automation',
      description: 'Preflight saved exports and Web/native scenarios, returning blockers, warnings, suggested Runner capabilities, and job_submit payloads without executing them.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().optional(),
        manifestPath: z.string().max(1000).optional(),
        scenarioIds: z.array(z.string().min(1).max(100)).max(100).optional(),
        exportPresets: z.array(z.string().min(1).max(200)).max(20).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async args => context.toolText(await planGodotAutomation(context, args)));

    server.registerTool('godot_quality_report', {
      title: 'Generate Godot quality report',
      description: 'Generate consolidated workspace-contained HTML and JSON reports covering runtime, project audit, dependencies, and automation readiness.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().optional(),
        manifestPath: z.string().max(1000).optional(),
        htmlPath: z.string().max(1000).optional(),
        jsonPath: z.string().max(1000).optional(),
        includeAllScenes: z.boolean().optional(),
        maxGraphNodes: z.number().int().min(1).max(5000).optional(),
        timeoutMs: z.number().int().min(1000).max(60000).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    }, async args => {
      const result = await writeGodotQualityReport(context, args);
      await context.audit('quality_report', { workspace: result.workspace.id, projectSubpath: result.projectSubpath, ok: result.ok, ...result.report });
      return context.toolText({
        ...result,
        reportPath: result.report.jsonPath,
        artifactPaths: [result.report.htmlPath, result.report.jsonPath]
      });
    });

    server.registerTool('godot_quick_setup', {
      title: 'Configure Godot project integration',
      description: 'Configure Godot executable/project defaults and optionally install the reviewed QA Bridge in one workspace-scoped operation.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().optional(),
        executablePath: z.string().max(2000).optional(),
        defaultWebPreset: z.string().max(200).optional(),
        defaultWebOutput: z.string().max(1000).optional(),
        defaultExportRoot: z.string().max(1000).optional(),
        installBridge: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    }, async args => {
      context.assertCanMutate('Configuring Godot integration');
      const configured = configureGodot(context, args);
      const bridge = configured.installBridge ? await installQaBridge(configured.project.root) : null;
      await context.audit('quick_setup', {
        workspace: configured.project.workspace.id,
        projectSubpath: configured.project.subpath,
        executableConfigured: !!configured.settings.executablePath,
        bridgeInstalled: !!bridge
      });
      return context.toolText({
        configured: true,
        workspace: { id: configured.project.workspace.id, name: configured.project.workspace.name },
        projectSubpath: configured.project.subpath,
        settings: configured.settings,
        bridge,
        next: ['godot_runtime_status', 'godot_project_audit', 'godot_automation_plan']
      });
    });
  }
});

export const __test = { configureGodot };
