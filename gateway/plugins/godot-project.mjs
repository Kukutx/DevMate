import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

function unquote(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  return text;
}

export function parseGodotConfig(text) {
  const sections = new Map();
  let section = '';
  sections.set(section, {});
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (!sections.has(section)) sections.set(section, {});
      continue;
    }
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    const value = unquote(line.slice(index + 1));
    sections.get(section)[key] = value;
  }
  return sections;
}

export function parseExportPresets(text) {
  const sections = parseGodotConfig(text);
  const presets = [];
  for (const [section, values] of sections) {
    const match = section.match(/^preset\.(\d+)$/);
    if (!match) continue;
    presets.push({
      index: Number(match[1]),
      name: values.name || '',
      platform: values.platform || '',
      runnable: values.runnable === 'true',
      exportPath: values.export_path || '',
      dedicatedServer: values.dedicated_server === 'true'
    });
  }
  return presets.sort((a, b) => a.index - b.index);
}

export function parseGodotDiagnostics(stdout = '', stderr = '') {
  const items = [];
  for (const [stream, text] of [['stdout', stdout], ['stderr', stderr]]) {
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      let severity = null;
      if (/^(SCRIPT ERROR|ERROR|Parse Error|E\s+\d+:)/i.test(line)) severity = 'error';
      else if (/^(WARNING|W\s+\d+:)/i.test(line)) severity = 'warning';
      if (!severity) continue;
      const location = line.match(/(?:at:\s*)?(.+?\.(?:gd|cs)):(\d+)(?::(\d+))?/i);
      items.push({
        severity,
        stream,
        message: line.slice(0, 4000),
        path: location?.[1] || null,
        line: location ? Number(location[2]) : null,
        column: location?.[3] ? Number(location[3]) : null
      });
    }
  }
  return items;
}

export async function scanProject(root, maxFiles = 4000) {
  const counts = { scenes: 0, scripts: 0, resources: 0, assets: 0, shaders: 0, addons: 0 };
  const samples = { scenes: [], scripts: [], resources: [], addons: [] };
  const skip = new Set(['.git', '.godot', 'build', 'dist', 'node_modules', '.import']);
  let visited = 0;
  async function walk(directory) {
    if (visited >= maxFiles) return;
    let entries = [];
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (visited >= maxFiles) break;
      if (entry.isDirectory() && skip.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile()) continue;
      visited += 1;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === '.tscn' || ext === '.scn') { counts.scenes += 1; if (samples.scenes.length < 100) samples.scenes.push(rel); }
      else if (ext === '.gd' || ext === '.cs') { counts.scripts += 1; if (samples.scripts.length < 100) samples.scripts.push(rel); }
      else if (ext === '.tres' || ext === '.res') { counts.resources += 1; if (samples.resources.length < 100) samples.resources.push(rel); }
      else if (ext === '.gdshader' || ext === '.shader') counts.shaders += 1;
      else if (['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ogg', '.wav', '.mp3', '.glb', '.gltf', '.ttf', '.otf', '.woff', '.woff2'].includes(ext)) counts.assets += 1;
      if (/^addons\/[^/]+\/plugin\.cfg$/i.test(rel)) {
        counts.addons += 1;
        if (samples.addons.length < 100) samples.addons.push(rel);
      }
    }
  }
  await walk(root);
  return { counts, samples, scannedFiles: visited, truncated: visited >= maxFiles };
}

export function projectMetadata(projectFileText) {
  const sections = parseGodotConfig(projectFileText);
  const application = sections.get('application') || {};
  const rendering = sections.get('rendering') || {};
  const display = sections.get('display') || {};
  const autoload = sections.get('autoload') || {};
  const input = sections.get('input') || {};
  return {
    name: application['config/name'] || null,
    mainScene: application['run/main_scene'] || null,
    icon: application['config/icon'] || null,
    features: application['config/features'] || null,
    renderingMethod: rendering['renderer/rendering_method'] || rendering['renderer/rendering_method.mobile'] || null,
    viewportWidth: display['window/size/viewport_width'] ? Number(display['window/size/viewport_width']) : null,
    viewportHeight: display['window/size/viewport_height'] ? Number(display['window/size/viewport_height']) : null,
    autoloads: Object.entries(autoload).map(([name, rawPath]) => ({
      name,
      singleton: String(rawPath).startsWith('*'),
      path: String(rawPath).replace(/^\*/, '')
    })),
    inputActions: Object.keys(input).sort()
  };
}

export function normalizeScene(scene) {
  if (!scene) return null;
  const value = String(scene).trim().replace(/\\/g, '/');
  if (!value) return null;
  if (path.isAbsolute(value) || value.split('/').includes('..')) throw new Error('Godot scene must stay inside the project');
  if (!value.startsWith('res://') && !/\.(?:tscn|scn)$/i.test(value)) throw new Error('Godot scene must be a res:// path or a relative .tscn/.scn path');
  return value;
}

export function resolveGodotExecutable(context) {
  const configured = String(context.settings.executablePath || '').trim();
  const candidates = [configured, 'godot4', 'godot'];
  if (process.platform === 'win32') candidates.push('godot4.exe', 'godot.exe');
  const executable = context.executables.find(candidates);
  if (!executable) throw new Error('Godot executable not found. Configure devmate.godot executablePath or add Godot to PATH.');
  context.executables.assertAllowed(executable);
  return executable;
}

export function resolveProject(context, workspaceId, projectSubpath, { writable = false } = {}) {
  const workspace = context.workspace.get(workspaceId, { writable });
  const subpath = projectSubpath || context.settings.defaultProjectSubpath || '.';
  const root = context.workspace.resolve(workspace, subpath, { mustExist: true, directory: true });
  const projectFile = path.join(root, 'project.godot');
  if (!fs.statSync(projectFile, { throwIfNoEntry: false })?.isFile()) throw new Error(`project.godot not found under ${subpath}`);
  return { workspace, root, subpath, projectFile };
}

export async function readExportPresets(projectRoot) {
  const presetFile = path.join(projectRoot, 'export_presets.cfg');
  return fs.statSync(presetFile, { throwIfNoEntry: false })?.isFile()
    ? parseExportPresets(await fsp.readFile(presetFile, 'utf8'))
    : [];
}

export async function inspectProject(context, workspaceId, projectSubpath) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: false });
  const text = await fsp.readFile(project.projectFile, 'utf8');
  const presets = await readExportPresets(project.root);
  const scan = await scanProject(project.root);
  return {
    workspace: { id: project.workspace.id, name: project.workspace.name },
    project: {
      subpath: project.subpath,
      root: project.root,
      ...projectMetadata(text),
      hasExportPresets: presets.length > 0,
      presets,
      ...scan
    }
  };
}

export async function validateProject(context, { workspaceId, projectSubpath, timeoutMs }) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const executable = resolveGodotExecutable(context);
  const args = ['--headless', '--editor', '--path', project.root, '--quit'];
  const result = await context.executables.run(executable, args, {
    cwd: project.root,
    timeoutMs: timeoutMs || context.settings.validationTimeoutMs || 300000,
    maxOutputChars: 300000
  });
  const diagnostics = parseGodotDiagnostics(result.stdout, result.stderr);
  return {
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    executable,
    result,
    diagnostics,
    errors: diagnostics.filter(item => item.severity === 'error'),
    warnings: diagnostics.filter(item => item.severity === 'warning'),
    ok: result.exitCode === 0 && !result.timedOut && diagnostics.every(item => item.severity !== 'error')
  };
}

function safeRelativeOutput(value) {
  const output = String(value || '').trim().replace(/\\/g, '/');
  if (!output) throw new Error('Godot export outputPath is required');
  if (path.isAbsolute(output) || output.split('/').includes('..')) throw new Error('Godot export outputPath must stay inside the project workspace');
  return output;
}

function slug(value) {
  return String(value || 'game').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'game';
}

export function defaultExportOutput(preset, projectName = 'game', root = 'build/exports') {
  const platform = String(preset?.platform || '').toLowerCase();
  const base = slug(projectName);
  const folder = `${String(root || 'build/exports').replace(/\/$/, '')}/${slug(preset?.name || preset?.platform || 'export')}`;
  if (platform.includes('web')) return `${folder}/index.html`;
  if (platform.includes('windows')) return `${folder}/${base}.exe`;
  if (platform.includes('linux')) return `${folder}/${base}.x86_64`;
  if (platform.includes('mac')) return `${folder}/${base}.zip`;
  if (platform.includes('android')) return `${folder}/${base}.apk`;
  if (platform.includes('ios')) return `${folder}/${base}.zip`;
  return `${folder}/${base}.pck`;
}

async function artifactSummary(target, maxFiles = 5000) {
  const stat = fs.statSync(target, { throwIfNoEntry: false });
  if (!stat) return { exists: false, type: null, bytes: 0, files: 0, truncated: false };
  if (stat.isFile()) return { exists: true, type: 'file', bytes: stat.size, files: 1, truncated: false };
  if (!stat.isDirectory()) return { exists: true, type: 'other', bytes: 0, files: 0, truncated: false };
  let bytes = 0;
  let files = 0;
  let truncated = false;
  async function walk(directory) {
    if (files >= maxFiles) { truncated = true; return; }
    let entries = [];
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files >= maxFiles) { truncated = true; break; }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        files += 1;
        try { bytes += (await fsp.stat(full)).size; } catch {}
      }
    }
  }
  await walk(target);
  return { exists: true, type: 'directory', bytes, files, truncated };
}

export async function exportProject(context, { workspaceId, projectSubpath, preset, outputPath, outputRoot, mode = 'release', timeoutMs }) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const executable = resolveGodotExecutable(context);
  const presets = await readExportPresets(project.root);
  if (!presets.length) throw new Error('No Godot export presets are configured');
  const selectedPreset = preset || presets.find(item => item.runnable)?.name || presets[0].name;
  const presetInfo = presets.find(item => item.name === selectedPreset) || null;
  if (!presetInfo) throw new Error(`Godot export preset not found: ${selectedPreset}`);
  const projectText = await fsp.readFile(project.projectFile, 'utf8');
  const metadata = projectMetadata(projectText);
  const relativeOutput = safeRelativeOutput(outputPath || presetInfo.exportPath || defaultExportOutput(presetInfo, metadata.name, outputRoot || context.settings.defaultExportRoot || 'build/exports'));
  const output = context.workspace.resolve(project.workspace, path.join(project.subpath, relativeOutput));
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const args = ['--headless', '--path', project.root, mode === 'debug' ? '--export-debug' : '--export-release', selectedPreset, output];
  const result = await context.executables.run(executable, args, {
    cwd: project.root,
    timeoutMs: timeoutMs || context.settings.exportTimeoutMs || 600000,
    maxOutputChars: 300000
  });
  const diagnostics = parseGodotDiagnostics(result.stdout, result.stderr);
  const artifact = await artifactSummary(output);
  return {
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    executable,
    preset: selectedPreset,
    presetInfo,
    mode,
    outputPath: path.relative(project.workspace.root, output).replace(/\\/g, '/'),
    artifact,
    result,
    diagnostics,
    ok: result.exitCode === 0 && !result.timedOut && artifact.exists && diagnostics.every(item => item.severity !== 'error')
  };
}

export async function exportMatrix(context, { workspaceId, projectSubpath, targets = [], mode = 'release', outputRoot, timeoutMs, stopOnFailure = true, reportPath }) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const presets = await readExportPresets(project.root);
  if (!presets.length) throw new Error('No Godot export presets are configured');
  const selected = targets.length ? targets : presets.map(item => ({ preset: item.name }));
  if (selected.length > 20) throw new Error('Godot export matrix supports at most 20 targets');
  const results = [];
  for (const target of selected) {
    const item = await exportProject(context, {
      workspaceId: project.workspace.id,
      projectSubpath: project.subpath,
      preset: target.preset,
      outputPath: target.outputPath,
      outputRoot,
      mode: target.mode || mode,
      timeoutMs: target.timeoutMs || timeoutMs
    });
    results.push(item);
    if (!item.ok && stopOnFailure) break;
  }
  const passed = results.filter(item => item.ok).length;
  const report = {
    ok: results.length === selected.length && passed === selected.length,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    requested: selected.length,
    completed: results.length,
    passed,
    failed: results.length - passed,
    stoppedEarly: results.length < selected.length,
    results
  };
  if (reportPath) {
    const relative = safeRelativeOutput(reportPath);
    const full = context.workspace.resolve(project.workspace, path.join(project.subpath, relative));
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    report.reportPath = path.relative(project.workspace.root, full).replace(/\\/g, '/');
  }
  return report;
}

export async function exportWeb(context, { workspaceId, projectSubpath, preset, outputPath, mode, timeoutMs, startLocalPreview, crossOriginIsolation }, browserService) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const presets = await readExportPresets(project.root);
  const selectedPreset = preset || context.settings.defaultWebPreset || 'Web';
  const presetInfo = presets.find(item => item.name === selectedPreset) || null;
  if (presets.length > 0 && !presetInfo) throw new Error(`Godot export preset not found: ${selectedPreset}`);
  if (presetInfo && !/web/i.test(presetInfo.platform)) throw new Error(`Godot preset ${selectedPreset} is not a Web preset (${presetInfo.platform})`);
  const relativeOutput = outputPath || context.settings.defaultWebOutput || 'build/web/index.html';
  if (path.extname(relativeOutput).toLowerCase() !== '.html') throw new Error('Godot Web outputPath must end with .html');
  const exported = await exportProject(context, {
    workspaceId,
    projectSubpath,
    preset: selectedPreset,
    outputPath: relativeOutput,
    mode: mode || 'debug',
    timeoutMs
  });
  let preview = null;
  if (exported.ok && startLocalPreview !== false) {
    if (!browserService?.startPreview) throw new Error('Browser QA preview service is unavailable');
    const output = context.workspace.resolve(project.workspace, exported.outputPath);
    preview = await browserService.startPreview({
      workspaceId: project.workspace.id,
      root: path.dirname(output),
      entryPath: path.basename(output),
      crossOriginIsolation: !!crossOriginIsolation
    });
  }
  return { ...exported, preview };
}

export const __test = {
  artifactSummary,
  defaultExportOutput,
  normalizeScene,
  parseGodotConfig,
  parseExportPresets,
  parseGodotDiagnostics,
  projectMetadata,
  safeRelativeOutput
};
