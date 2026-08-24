import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { assertSafeWorkspacePath } from '../sensitive-path-policy.mjs';

export const AUTOMATION_SCHEMA_VERSION = 1;
export const DEFAULT_AUTOMATION_MANIFEST = '.devmate/automation.json';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeManifestPath(value = DEFAULT_AUTOMATION_MANIFEST) {
  const relative = String(value || DEFAULT_AUTOMATION_MANIFEST).trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!relative || path.posix.isAbsolute(relative) || relative.split('/').includes('..')) {
    const error = new Error('DevMate automation manifest path must stay inside the workspace');
    error.code = 'automation_manifest_path_boundary';
    throw error;
  }
  assertSafeWorkspacePath(relative, 'DevMate automation manifest path');
  return relative;
}

function validateTopLevel(value) {
  if (!isPlainObject(value)) throw new Error('DevMate automation manifest must be a JSON object');
  if (value.schemaVersion !== AUTOMATION_SCHEMA_VERSION) {
    throw new Error(`Unsupported DevMate automation schemaVersion: ${value.schemaVersion ?? '(missing)'}`);
  }
  if (!isPlainObject(value.plugins)) throw new Error('DevMate automation manifest must contain a plugins object');
  for (const [pluginId, config] of Object.entries(value.plugins)) {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(pluginId)) throw new Error(`Invalid automation plugin id: ${pluginId}`);
    if (!isPlainObject(config)) throw new Error(`Automation config for ${pluginId} must be an object`);
  }
  return value;
}

export async function loadAutomationManifest(context, { workspaceId, manifestPath = DEFAULT_AUTOMATION_MANIFEST, required = true } = {}) {
  const workspace = context.workspace.get(workspaceId, { writable: false });
  const safePath = safeManifestPath(manifestPath);
  const file = context.workspace.resolve(workspace, safePath, { mustExist: false });
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) {
    if (!required) return { workspace: { id: workspace.id, name: workspace.name }, manifestPath: safePath, exists: false, manifest: null };
    throw new Error(`DevMate automation manifest not found: ${safePath}`);
  }
  if (!stat.isFile()) throw new Error(`DevMate automation manifest is not a file: ${safePath}`);
  if (stat.size > 1024 * 1024) throw new Error(`DevMate automation manifest is too large: ${stat.size} bytes`);
  let parsed;
  try { parsed = JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Invalid DevMate automation manifest JSON: ${error.message}`); }
  const manifest = validateTopLevel(parsed);
  return {
    workspace: { id: workspace.id, name: workspace.name },
    manifestPath: path.relative(workspace.root, file).replace(/\\/g, '/'),
    exists: true,
    manifest
  };
}

export function pluginAutomationConfig(manifest, pluginId) {
  if (!manifest) return {};
  const config = manifest.plugins?.[pluginId];
  if (config == null) return {};
  if (!isPlainObject(config)) throw new Error(`Automation config for ${pluginId} must be an object`);
  return config;
}

export function scenarioById(scenarios, id) {
  const list = Array.isArray(scenarios) ? scenarios : [];
  const wanted = String(id || '').trim();
  if (!wanted) throw new Error('scenarioId is required');
  const matches = list.filter(item => String(item?.id || '') === wanted);
  if (matches.length === 0) throw new Error(`Automation scenario not found: ${wanted}`);
  if (matches.length > 1) throw new Error(`Duplicate automation scenario id: ${wanted}`);
  return matches[0];
}

export function automationManifestTemplate() {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    plugins: {
      'devmate.browser-qa': { scenarios: [] },
      'devmate.godot': {
        projectSubpath: '.',
        preset: 'Web',
        outputPath: 'build/web/index.html',
        mode: 'debug',
        exportMode: 'release',
        exportOutputRoot: 'build/exports',
        exports: [
          { preset: 'Web', outputPath: 'build/web/index.html' }
        ],
        scenarios: [
          {
            id: 'native-smoke',
            kind: 'native',
            runForMs: 3000,
            reportPath: 'artifacts/godot-qa/native-smoke.json',
            assertions: [
              { statePath: 'runtime.bridge_ready', operator: 'truthy' }
            ]
          }
        ]
      },
      'devmate.godot-advanced': {
        projectSubpath: '.',
        scenarios: [
          {
            id: 'performance-smoke',
            kind: 'performance',
            scene: 'res://main.tscn',
            runForMs: 5000,
            warmupMs: 1000,
            sampleIntervalMs: 250,
            budgets: {
              minSamples: 8,
              minFpsP05: 30,
              maxProcessMsP95: 25,
              maxOrphanNodeCount: 0
            },
            reportPath: 'artifacts/godot-performance/performance-smoke.json'
          }
        ]
      }
    }
  };
}

export const __test = { isPlainObject, safeManifestPath, validateTopLevel };
