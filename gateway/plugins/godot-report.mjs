import fsp from 'node:fs/promises';
import path from 'node:path';
import { auditGodotProject } from './godot-audit.mjs';
import { buildGodotDependencyGraph } from './godot-graph.mjs';
import { planGodotAutomation } from './godot-plan.mjs';
import { inspectGodotRuntime } from './godot-runtime.mjs';
import { resolveProject } from './godot-project.mjs';

function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function statusClass(ok) {
  return ok ? 'ok' : 'bad';
}

function list(items, render) {
  if (!items?.length) return '<div class="empty">None</div>';
  return `<ul>${items.map(render).join('')}</ul>`;
}

function renderIssues(issues = []) {
  return list(issues, item => `<li class="${escapeHtml(item.level || 'info')}"><strong>${escapeHtml(item.code || item.level || 'issue')}</strong> ${escapeHtml(item.message || '')}</li>`);
}

function renderPlanItems(items = []) {
  return list(items, item => `<li><div class="row"><strong>${escapeHtml(item.id)}</strong><span class="pill ${statusClass(!item.blockers?.length)}">${item.blockers?.length ? 'blocked' : 'ready'}</span></div><div class="muted">${escapeHtml(item.tool)} · ${escapeHtml((item.requiredCapabilities || []).join(', '))}</div>${renderIssues([...(item.blockers || []), ...(item.warnings || [])])}</li>`);
}

function renderReport(data) {
  const { generatedAt, runtime, audit, graph, plan } = data;
  const auditIssues = [...(audit.issues?.errors || []), ...(audit.issues?.warnings || []), ...(audit.issues?.info || [])];
  const graphProblems = [
    ...graph.missing.map(resource => ({ level: 'error', code: 'missing_dependency', message: resource })),
    ...graph.cycles.map(cycle => ({ level: 'warning', code: 'dependency_cycle', message: cycle.join(' → ') }))
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DevMate Godot Quality Report</title>
<style>
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}body{margin:0;background:Canvas;color:CanvasText}.wrap{max-width:1120px;margin:auto;padding:28px}.top{display:flex;justify-content:space-between;gap:18px;align-items:flex-start}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:18px 0}.card,.section{border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:12px;padding:15px;background:color-mix(in srgb,Canvas 96%,CanvasText 4%)}.section{margin-top:14px}.label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;opacity:.7}.value{font-size:21px;font-weight:700;margin-top:4px}.row{display:flex;justify-content:space-between;gap:12px}.pill{border-radius:999px;padding:2px 8px;font-size:11px;border:1px solid currentColor}.pill.ok,.info{color:#2f9e44}.pill.bad,.error{color:#e03131}.warning{color:#f08c00}.muted,.empty{opacity:.68;font-size:12px}h1{margin:0;font-size:24px}h2{font-size:17px;margin:0 0 10px}ul{margin:0;padding-left:20px}li{margin:7px 0;overflow-wrap:anywhere}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}</style>
</head>
<body><main class="wrap">
<div class="top"><div><h1>DevMate Godot Quality Report</h1><div class="muted">${escapeHtml(audit.project?.name || 'Godot project')} · generated ${escapeHtml(generatedAt)}</div></div><span class="pill ${statusClass(data.ok)}">${data.ok ? 'READY' : 'ATTENTION'}</span></div>
<div class="grid">
<div class="card"><div class="label">Godot</div><div class="value">${escapeHtml(runtime.version?.raw || 'Unavailable')}</div><div class="muted">${escapeHtml(runtime.executableName || '')}</div></div>
<div class="card"><div class="label">Audit</div><div class="value">${audit.summary.errors || 0} / ${audit.summary.warnings || 0}</div><div class="muted">errors / warnings</div></div>
<div class="card"><div class="label">Dependencies</div><div class="value">${graph.summary.nodes}</div><div class="muted">${graph.summary.edges} edges · ${graph.summary.missing} missing</div></div>
<div class="card"><div class="label">Automation</div><div class="value">${plan.summary.ready}/${plan.summary.items}</div><div class="muted">ready items</div></div>
</div>
<section class="section"><h2>Runtime readiness</h2>${renderIssues([
    ...(!runtime.readiness.validate ? [{ level: 'error', code: 'runtime_validate', message: 'Godot runtime validation is not ready.' }] : []),
    ...(!runtime.csharp.ready ? [{ level: 'error', code: 'csharp_runtime', message: 'C# project requires a Godot Mono build and dotnet.' }] : []),
    ...(!runtime.exportTemplates.available ? [{ level: 'warning', code: 'export_templates', message: 'Matching export templates were not detected.' }] : [])
  ])}<div class="muted">Host capabilities: ${escapeHtml(runtime.host.capabilities.join(', '))}</div></section>
<section class="section"><h2>Project audit</h2>${renderIssues(auditIssues)}</section>
<section class="section"><h2>Dependency graph</h2>${renderIssues(graphProblems)}<div class="muted">Entries: ${escapeHtml(graph.entries.join(', '))}</div></section>
<section class="section"><h2>Execution plan</h2>${renderPlanItems(plan.items)}</section>
</main></body></html>`;
}

export async function writeGodotQualityReport(context, {
  workspaceId,
  projectSubpath,
  manifestPath,
  htmlPath = 'artifacts/godot-quality/report.html',
  jsonPath = 'artifacts/godot-quality/report.json',
  includeAllScenes = false,
  maxGraphNodes = 500,
  timeoutMs = 15000
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const [runtime, audit, graph, plan] = await Promise.all([
    inspectGodotRuntime(context, { workspaceId: project.workspace.id, projectSubpath: project.subpath, timeoutMs }),
    auditGodotProject(context, { workspaceId: project.workspace.id, projectSubpath: project.subpath }),
    buildGodotDependencyGraph(context, { workspaceId: project.workspace.id, projectSubpath: project.subpath, includeAllScenes, maxNodes: maxGraphNodes }),
    planGodotAutomation(context, { workspaceId: project.workspace.id, projectSubpath: project.subpath, manifestPath })
  ]);
  const data = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: runtime.readiness.validate && audit.summary.errors === 0 && graph.summary.missing === 0 && plan.ok,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    runtime,
    audit,
    graph,
    plan
  };
  const htmlFile = context.workspace.resolve(project.workspace, path.join(project.subpath, htmlPath));
  const jsonFile = context.workspace.resolve(project.workspace, path.join(project.subpath, jsonPath));
  await Promise.all([fsp.mkdir(path.dirname(htmlFile), { recursive: true }), fsp.mkdir(path.dirname(jsonFile), { recursive: true })]);
  await Promise.all([
    fsp.writeFile(htmlFile, renderReport(data), 'utf8'),
    fsp.writeFile(jsonFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  ]);
  return {
    ...data,
    report: {
      htmlPath: path.relative(project.workspace.root, htmlFile).replace(/\\/g, '/'),
      jsonPath: path.relative(project.workspace.root, jsonFile).replace(/\\/g, '/')
    }
  };
}

export const __test = { escapeHtml, renderIssues, renderPlanItems, renderReport };
