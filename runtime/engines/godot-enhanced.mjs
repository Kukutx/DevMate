import { z } from 'zod';
import { extendPlugin } from './plugin-sdk.mjs';
import { godotPlugin } from './godot.mjs';
import { buildGodotDependencyGraph } from './godot-graph.mjs';
import { safeGodotRelativePath } from './godot-path-policy.mjs';
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
  // Only what this call sets is stored for the project; everything else keeps following the instance settings.
  const patch = { defaultProjectSubpath: project.subpath };
  if (executablePath !== undefined) {
    const raw = String(executablePath || '').trim();
    if (raw) {
      const resolved = context.executables.find([raw]);
      if (!resolved) throw new Error(`Godot executable not found: ${raw}`);
      context.executables.assertAllowed(resolved);
      patch.executablePath = resolved;
    } else patch.executablePath = '';
  }
  if (defaultWebPreset !== undefined) patch.defaultWebPreset = String(defaultWebPreset || '').trim();
  if (defaultWebOutput !== undefined) {
    patch.defaultWebOutput = safeGodotRelativePath(defaultWebOutput, 'build/web/index.html', 'Godot default Web output');
  }
  if (defaultExportRoot !== undefined) {
    patch.defaultExportRoot = safeGodotRelativePath(defaultExportRoot, 'build/exports', 'Godot default export root');
  }
  const settings = context.updateSettings(patch);
  return { project, settings, installBridge };
}

export const enhancedGodotPlugin = extendPlugin(godotPlugin, {
  version: '0.4.0',
  description: 'Godot project development, runtime verification, dependency analysis, native/Web acceptance, execution planning, quality reports, and multi-platform export orchestration.',
  async diagnose(context, base) {
    let runtime = null;
    try { runtime = await inspectGodotRuntime(context); }
    catch (error) { runtime = { ok: false, error: error.message || String(error) }; }
    return { ...(base || {}), runtime };
  },
  async activate(context) {
    const { server } = context;

    server.registerTool('runtime_status', {
      title: 'Godot runtime status',
      description: 'Inspect the configured Godot version, Standard/Mono build, matching export templates and .NET readiness by running Godot --version. Changes nothing.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().optional(),
        timeoutMs: z.number().int().min(1000).max(60000).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    }, async args => context.toolText(await inspectGodotRuntime(context, args)));

    server.registerTool('dependency_graph', {
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

    server.registerTool('automation_plan', {
      title: 'Plan Godot automation',
      description: 'Preflight saved exports and Web/native scenarios without executing them, returning blockers, warnings and, per item, the ready capability.call input and job.start payload.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().optional(),
        manifestPath: z.string().max(1000).optional(),
        scenarioIds: z.array(z.string().min(1).max(100)).max(100).optional(),
        exportPresets: z.array(z.string().min(1).max(200)).max(20).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async args => context.toolText(await planGodotAutomation(context, args)));

    server.registerTool('quality_report', {
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
        ok: result.ok,
        workspace: result.workspace,
        projectSubpath: result.projectSubpath,
        generatedAt: result.generatedAt,
        summary: {
          runtimeReady: result.runtime.readiness.validate,
          exportTemplatesAvailable: result.runtime.exportTemplates.available,
          audit: result.audit.summary,
          graph: result.graph.summary,
          automation: result.plan.summary
        },
        report: result.report,
        reportPath: result.report.jsonPath,
        artifactPaths: [result.report.htmlPath, result.report.jsonPath]
      });
    });

    server.registerTool('quick_setup', {
      title: 'Configure Godot project integration',
      description: 'Set the Godot executable and export defaults for this project and optionally install the reviewed QA Bridge, in one step. Instance-wide values are set with capability.configure.',
      ownerOnly: true,
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
      const bridge = configured.installBridge
        ? await installQaBridge(context, {
          workspaceId: configured.project.workspace.id,
          projectSubpath: configured.project.subpath
        })
        : null;
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
        next: ['godot.runtime_status', 'godot.project_audit', 'godot.automation_plan']
      });
    });
  }
});

export const __test = { configureGodot };
