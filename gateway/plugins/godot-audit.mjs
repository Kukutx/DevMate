import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { inspectQaBridge } from './godot-qa-bridge.mjs';
import { parseGodotConfig, projectMetadata, readExportPresets, resolveProject, resolveProjectChild, scanProject } from './godot-project.mjs';

const TEXT_REFERENCE_EXTENSIONS = new Set(['.tscn', '.tres', '.gd', '.gdshader', '.shader', '.cfg']);
const SKIP_DIRECTORIES = new Set(['.git', '.godot', '.import', 'build', 'dist', 'node_modules']);

function normalizeSlash(value) {
  return String(value || '').replace(/\\/g, '/');
}

function resourceRelative(value) {
  const text = String(value || '').replace(/^\*/, '');
  if (!text.startsWith('res://')) return null;
  const relative = text.slice('res://'.length).replace(/\\/g, '/');
  if (!relative || relative.split('/').includes('..')) return null;
  return relative;
}

function finding(severity, code, message, detail = {}) {
  return { severity, code, message, ...detail };
}

async function scanReferences(root, maxFiles = 3000, maxMissing = 200) {
  const references = new Map();
  const missing = [];
  let scannedFiles = 0;
  let truncated = false;
  async function walk(directory) {
    if (scannedFiles >= maxFiles || missing.length >= maxMissing) {
      truncated = true;
      return;
    }
    let entries = [];
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (scannedFiles >= maxFiles || missing.length >= maxMissing) {
        truncated = true;
        break;
      }
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !TEXT_REFERENCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      scannedFiles += 1;
      let text = '';
      try { text = await fsp.readFile(full, 'utf8'); } catch { continue; }
      const source = normalizeSlash(path.relative(root, full));
      const seen = new Set();
      for (const match of text.matchAll(/res:\/\/[A-Za-z0-9_@%+.,~()\[\]{}\-\/ ]+/g)) {
        const raw = match[0].replace(/[\s\]\[{}(),;]+$/g, '');
        const relative = resourceRelative(raw);
        if (!relative || seen.has(relative)) continue;
        seen.add(relative);
        let target = null;
        try { target = resolveProjectChild(root, relative); } catch {}
        const exists = !!target && !!fs.statSync(target, { throwIfNoEntry: false });
        references.set(relative, (references.get(relative) || 0) + 1);
        if (!exists) missing.push({ source, reference: `res://${relative}` });
      }
    }
  }
  await walk(root);
  return {
    scannedFiles,
    uniqueReferences: references.size,
    missing: missing.slice(0, maxMissing),
    truncated
  };
}

export async function auditGodotProject(context, { workspaceId, projectSubpath, maxFiles = 3000 } = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: false });
  const projectText = await fsp.readFile(project.projectFile, 'utf8');
  const metadata = projectMetadata(projectText);
  const presets = await readExportPresets(project.root);
  const scan = await scanProject(project.root, Math.min(10000, Math.max(100, Number(maxFiles) || 3000)));
  const references = await scanReferences(project.root, Math.min(10000, Math.max(100, Number(maxFiles) || 3000)));
  const qaBridge = await inspectQaBridge(project.root);
  const findings = [];

  if (!metadata.name) findings.push(finding('warning', 'project_name_missing', 'Project does not define application/config/name.'));
  if (!metadata.mainScene) {
    findings.push(finding('warning', 'main_scene_missing', 'Project does not define application/run/main_scene.'));
  } else {
    const mainRelative = resourceRelative(metadata.mainScene);
    if (mainRelative) {
      const mainFile = resolveProjectChild(project.root, mainRelative);
      if (!fs.statSync(mainFile, { throwIfNoEntry: false })?.isFile()) {
        findings.push(finding('error', 'main_scene_not_found', `Configured main scene does not exist: ${metadata.mainScene}`, { path: metadata.mainScene }));
      }
    } else if (!String(metadata.mainScene).startsWith('uid://')) {
      findings.push(finding('warning', 'main_scene_unresolved', `Configured main scene could not be resolved statically: ${metadata.mainScene}`));
    }
  }

  for (const autoload of metadata.autoloads) {
    const relative = resourceRelative(autoload.path);
    if (!relative) {
      findings.push(finding('warning', 'autoload_unresolved', `Autoload ${autoload.name} does not use a resolvable res:// path.`, { autoload }));
      continue;
    }
    if (!fs.statSync(resolveProjectChild(project.root, relative), { throwIfNoEntry: false })?.isFile()) {
      findings.push(finding('error', 'autoload_not_found', `Autoload ${autoload.name} points to a missing file: ${autoload.path}`, { autoload }));
    }
  }

  if (metadata.icon) {
    const iconRelative = resourceRelative(metadata.icon);
    if (iconRelative && !fs.statSync(resolveProjectChild(project.root, iconRelative), { throwIfNoEntry: false })?.isFile()) {
      findings.push(finding('warning', 'icon_not_found', `Configured project icon does not exist: ${metadata.icon}`, { path: metadata.icon }));
    }
  }

  if (!scan.counts.scenes) findings.push(finding('error', 'no_scenes', 'No .tscn or .scn files were found in the project scan.'));
  if (!presets.length) findings.push(finding('warning', 'export_presets_missing', 'No export_presets.cfg presets are configured.'));
  for (const preset of presets) {
    if (!preset.name || !preset.platform) findings.push(finding('error', 'export_preset_incomplete', `Export preset ${preset.index} is missing a name or platform.`, { preset }));
    if (!preset.exportPath) findings.push(finding('info', 'export_path_generated', `Preset ${preset.name || preset.index} has no export_path; DevMate will generate a safe build/exports path.`, { preset: preset.name }));
  }

  const webPresets = presets.filter(item => /web/i.test(item.platform) || /web/i.test(item.name));
  if (webPresets.length && metadata.renderingMethod && !/gl_compatibility/i.test(metadata.renderingMethod)) {
    findings.push(finding('warning', 'web_renderer_risk', `Web export is configured while the renderer is ${metadata.renderingMethod}; verify the Compatibility renderer for browser targets.`, { renderer: metadata.renderingMethod }));
  }

  const hasCSharp = scan.samples.scripts.some(item => item.toLowerCase().endsWith('.cs'));
  if (hasCSharp) {
    const rootEntries = await fsp.readdir(project.root).catch(() => []);
    const hasSolution = rootEntries.some(item => /\.(?:sln|csproj)$/i.test(item));
    if (!hasSolution) findings.push(finding('warning', 'csharp_solution_missing', 'C# scripts were found but no root .sln or .csproj was detected.'));
  }

  if (references.missing.length) {
    findings.push(finding('error', 'missing_resource_references', `${references.missing.length} missing res:// reference(s) were found.`, {
      count: references.missing.length,
      samples: references.missing.slice(0, 50)
    }));
  }
  if (references.truncated || scan.truncated) findings.push(finding('info', 'audit_truncated', 'The bounded project audit reached its scan limit.', { maxFiles }));
  if (!qaBridge.installed) findings.push(finding('info', 'qa_bridge_not_installed', 'DevMate QA Bridge is not installed; native and structured Web state assertions will be limited.'));

  const summary = {
    errors: findings.filter(item => item.severity === 'error').length,
    warnings: findings.filter(item => item.severity === 'warning').length,
    info: findings.filter(item => item.severity === 'info').length
  };
  return {
    ok: summary.errors === 0,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    metadata,
    inputs: { count: metadata.inputActions.length, actions: metadata.inputActions },
    autoloads: metadata.autoloads,
    presets,
    scan,
    references,
    qaBridge,
    summary,
    readiness: {
      runnable: summary.errors === 0 && !!metadata.mainScene,
      exportable: summary.errors === 0 && presets.length > 0,
      webAcceptance: summary.errors === 0 && webPresets.length > 0 && qaBridge.installed,
      nativeAcceptance: summary.errors === 0 && qaBridge.installed
    },
    findings
  };
}

export const __test = { resourceRelative, scanReferences };
