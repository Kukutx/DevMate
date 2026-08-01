import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { inspectQaBridge } from './godot-qa-bridge.mjs';
import { projectMetadata, readExportPresets, resolveProject } from './godot-project.mjs';
import { inspectGodotTests } from './godot-tests.mjs';

const SCHEMA_VERSION = 1;

function safeRelative(value = '.devmate/automation.json') {
  const relative = String(value || '.devmate/automation.json').trim().replace(/\\/g, '/');
  if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Godot automation manifest path must stay inside the workspace');
  return relative;
}

async function readExisting(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new Error('Godot automation manifest path is not a file');
  if (stat.size > 1024 * 1024) throw new Error('Godot automation manifest exceeds 1 MiB');
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Invalid existing automation manifest: ${error.message}`); }
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function uniqueById(items = []) {
  const output = [];
  const seen = new Set();
  for (const item of items) {
    const id = String(item?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    output.push(item);
  }
  return output;
}

function mergeById(existing = [], generated = []) {
  const existingIds = new Set(existing.map(item => String(item?.id || '')).filter(Boolean));
  return [...existing, ...generated.filter(item => !existingIds.has(String(item.id || '')))];
}

function exportTargets(presets, maxTargets = 8) {
  const selected = [];
  const web = presets.find(item => /web/i.test(item.platform) || /web/i.test(item.name));
  const runnable = presets.find(item => item.runnable);
  if (web) selected.push({ preset: web.name, ...(web.exportPath ? { outputPath: web.exportPath } : {}) });
  if (runnable && runnable.name !== web?.name) selected.push({ preset: runnable.name, ...(runnable.exportPath ? { outputPath: runnable.exportPath } : {}) });
  for (const preset of presets) {
    if (selected.length >= maxTargets) break;
    if (selected.some(item => item.preset === preset.name)) continue;
    selected.push({ preset: preset.name, ...(preset.exportPath ? { outputPath: preset.exportPath } : {}) });
  }
  return selected;
}

function generatedCoreConfig({ projectSubpath, metadata, presets, bridge }) {
  const webPreset = presets.find(item => /web/i.test(item.platform) || /web/i.test(item.name));
  const scenarios = [];
  if (metadata.mainScene) {
    scenarios.push({
      id: 'native-smoke',
      description: 'Main scene loads in native/headless Godot and exposes QA Bridge runtime state.',
      kind: 'native',
      scene: metadata.mainScene,
      runForMs: 3000,
      reportPath: 'artifacts/godot-qa/native-smoke.json',
      assertions: [{ statePath: 'runtime.bridge_ready', operator: 'truthy' }]
    });
  }
  if (webPreset) {
    scenarios.push({
      id: 'web-smoke',
      description: 'Web export loads a visible canvas without browser errors.',
      kind: 'web',
      preset: webPreset.name,
      outputPath: webPreset.exportPath || 'build/web/index.html',
      actions: [{ type: 'expect_visible', selector: 'canvas' }],
      screenshotPath: 'artifacts/godot-qa/web-smoke.png',
      reportPath: 'artifacts/godot-qa/web-smoke.json'
    });
  }
  return {
    projectSubpath,
    preset: webPreset?.name || 'Web',
    outputPath: webPreset?.exportPath || 'build/web/index.html',
    mode: 'debug',
    exportMode: 'release',
    exportOutputRoot: 'build/exports',
    exports: exportTargets(presets),
    scenarios,
    bootstrap: {
      generatedBy: 'DevMate',
      qaBridgeCurrent: bridge.current === true
    }
  };
}

function generatedAdvancedConfig({ metadata, tests }) {
  const scenarios = [];
  if (metadata.mainScene) {
    scenarios.push({
      id: 'performance-main',
      kind: 'performance',
      description: 'Collect a stable main-scene performance sample before adding explicit budgets.',
      scene: metadata.mainScene,
      headless: true,
      runForMs: 5000,
      warmupMs: 1000,
      sampleIntervalMs: 250,
      maxSamples: 600,
      reportPath: 'artifacts/godot-performance/main.json'
    });
  }
  if (tests.frameworks?.gut?.installed) {
    scenarios.push({ id: 'tests-gut', kind: 'gut', description: 'Run project-local GUT tests.', reportPath: 'artifacts/godot-tests/gut.xml' });
  } else if (tests.frameworks?.gdunit4?.installed) {
    scenarios.push({ id: 'tests-gdunit4', kind: 'gdunit4', description: 'Run project-local GdUnit4 tests.', reportPath: 'artifacts/godot-tests/gdunit4.xml' });
  }
  return { scenarios };
}

export async function bootstrapGodotAutomation(context, {
  workspaceId,
  projectSubpath,
  manifestPath = '.devmate/automation.json',
  includeAdvanced = true,
  merge = true,
  dryRun = false
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: !dryRun });
  const relative = safeRelative(manifestPath);
  const file = context.workspace.resolve(project.workspace, path.join(project.subpath, relative));
  const existing = await readExisting(file);
  if (existing && !merge) throw new Error(`Automation manifest already exists: ${relative}; use merge=true to preserve existing scenarios`);
  const projectText = await fsp.readFile(project.projectFile, 'utf8');
  const metadata = projectMetadata(projectText);
  const presets = await readExportPresets(project.root);
  const bridge = await inspectQaBridge(project.root);
  const tests = await inspectGodotTests(context, { workspaceId: project.workspace.id, projectSubpath: project.subpath, maxFiles: 5000 });
  const current = existing || { schemaVersion: SCHEMA_VERSION, plugins: {} };
  if (current.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported automation manifest schemaVersion: ${current.schemaVersion}`);
  current.plugins = object(current.plugins);
  const generatedCore = generatedCoreConfig({ projectSubpath: project.subpath, metadata, presets, bridge });
  const previousCore = object(current.plugins['devmate.godot']);
  current.plugins['devmate.godot'] = {
    ...generatedCore,
    ...previousCore,
    exports: previousCore.exports?.length ? previousCore.exports : generatedCore.exports,
    scenarios: mergeById(Array.isArray(previousCore.scenarios) ? previousCore.scenarios : [], generatedCore.scenarios)
  };
  if (includeAdvanced) {
    const generatedAdvanced = generatedAdvancedConfig({ metadata, tests });
    const previousAdvanced = object(current.plugins['devmate.godot-advanced']);
    current.plugins['devmate.godot-advanced'] = {
      ...generatedAdvanced,
      ...previousAdvanced,
      scenarios: mergeById(Array.isArray(previousAdvanced.scenarios) ? previousAdvanced.scenarios : [], generatedAdvanced.scenarios)
    };
  }
  current.plugins['devmate.godot'].scenarios = uniqueById(current.plugins['devmate.godot'].scenarios);
  if (current.plugins['devmate.godot-advanced']) current.plugins['devmate.godot-advanced'].scenarios = uniqueById(current.plugins['devmate.godot-advanced'].scenarios);
  const output = `${JSON.stringify(current, null, 2)}\n`;
  let backupPath = null;
  if (!dryRun) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    if (existing) {
      const backup = `${file}.${Date.now()}.bak`;
      await fsp.copyFile(file, backup);
      backupPath = path.relative(project.workspace.root, backup).replace(/\\/g, '/');
    }
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporary, output, 'utf8');
    await fsp.rename(temporary, file);
  }
  return {
    changed: !existing || JSON.stringify(existing) !== JSON.stringify(current),
    dryRun,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    manifestPath: path.relative(project.workspace.root, file).replace(/\\/g, '/'),
    backupPath,
    summary: {
      exportTargets: current.plugins['devmate.godot'].exports?.length || 0,
      coreScenarios: current.plugins['devmate.godot'].scenarios?.length || 0,
      advancedScenarios: current.plugins['devmate.godot-advanced']?.scenarios?.length || 0,
      qaBridgeCurrent: bridge.current === true,
      testFramework: tests.selectedFramework || null
    },
    manifest: current
  };
}

export const __test = { exportTargets, generatedAdvancedConfig, generatedCoreConfig, mergeById, safeRelative, uniqueById };
