import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { projectMetadata, resolveProject, scanProject } from './godot-project.mjs';

const TEXT_RESOURCE_EXTENSIONS = new Set([
  '.tscn', '.tres', '.gd', '.cs', '.gdshader', '.shader', '.godot', '.cfg', '.json', '.xml'
]);
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

function normalizeResourcePath(value = '') {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw || (raw.includes('://') && !raw.startsWith('res://'))) return null;
  if (raw.startsWith('res://')) {
    const relative = raw.slice(6).replace(/^\/+/, '');
    if (!relative || relative.split('/').includes('..')) return null;
    return `res://${relative}`;
  }
  if (path.isAbsolute(raw) || raw.split('/').includes('..')) return null;
  return `res://${raw.replace(/^\/+/, '')}`;
}

export function extractGodotReferences(text = '') {
  const references = new Set();
  const source = String(text || '');
  for (const match of source.matchAll(/["'](res:\/\/[^"']+)["']/g)) {
    const normalized = normalizeResourcePath(match[1]);
    if (normalized) references.add(normalized);
  }
  for (const match of source.matchAll(/res:\/\/[A-Za-z0-9_@%+.,~()\[\]{}\-\/]+/g)) {
    const normalized = normalizeResourcePath(match[0].replace(/[.:]+$/, ''));
    if (normalized) references.add(normalized);
  }
  return [...references].sort();
}

function parseAttributes(value = '') {
  const output = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)=("(?:\\.|[^"])*"|[^\s]+)/g;
  for (const match of String(value || '').matchAll(pattern)) {
    const raw = match[2];
    output[match[1]] = raw.startsWith('"') ? (() => { try { return JSON.parse(raw); } catch { return raw.slice(1, -1); } })() : raw;
  }
  return output;
}

export function parseSceneNodes(text = '') {
  const nodes = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const match = rawLine.trim().match(/^\[node\s+(.+)\]$/);
    if (!match) continue;
    const attributes = parseAttributes(match[1]);
    nodes.push({
      name: attributes.name || null,
      type: attributes.type || null,
      parent: attributes.parent || null,
      owner: attributes.owner || null,
      instance: attributes.instance || null
    });
  }
  return nodes;
}

function resourceType(resourcePath) {
  const ext = path.extname(resourcePath).toLowerCase();
  if (ext === '.tscn' || ext === '.scn') return 'scene';
  if (ext === '.tres' || ext === '.res') return 'resource';
  if (ext === '.gd') return 'gdscript';
  if (ext === '.cs') return 'csharp';
  if (ext === '.gdshader' || ext === '.shader') return 'shader';
  if (ext === '.glb' || ext === '.gltf') return 'model';
  if (['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(ext)) return 'texture';
  if (['.ogg', '.wav', '.mp3'].includes(ext)) return 'audio';
  return ext ? ext.slice(1) : 'file';
}

function fullPath(projectRoot, resourcePath) {
  const normalized = normalizeResourcePath(resourcePath);
  if (!normalized) throw new Error(`Invalid Godot resource path: ${resourcePath}`);
  const candidate = path.resolve(projectRoot, normalized.slice(6));
  const relative = path.relative(projectRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Godot resource escapes project: ${resourcePath}`);
  return candidate;
}

async function readTextResource(projectRoot, resourcePath) {
  const file = fullPath(projectRoot, resourcePath);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return { exists: false, file, size: 0, text: null, tooLarge: false };
  const ext = path.extname(file).toLowerCase();
  if (!TEXT_RESOURCE_EXTENSIONS.has(ext)) return { exists: true, file, size: stat.size, text: null, tooLarge: false };
  if (stat.size > MAX_TEXT_BYTES) return { exists: true, file, size: stat.size, text: null, tooLarge: true };
  return { exists: true, file, size: stat.size, text: await fsp.readFile(file, 'utf8'), tooLarge: false };
}

function findCycles(nodesByPath, maxCycles = 100) {
  const cycles = [];
  const visited = new Set();
  const active = new Set();
  const stack = [];
  function visit(resourcePath) {
    if (cycles.length >= maxCycles || active.has(resourcePath)) return;
    if (visited.has(resourcePath)) return;
    visited.add(resourcePath);
    active.add(resourcePath);
    stack.push(resourcePath);
    const node = nodesByPath.get(resourcePath);
    for (const target of node?.references || []) {
      if (active.has(target)) {
        const index = stack.indexOf(target);
        if (index >= 0) cycles.push([...stack.slice(index), target]);
      } else visit(target);
      if (cycles.length >= maxCycles) break;
    }
    stack.pop();
    active.delete(resourcePath);
  }
  for (const resourcePath of nodesByPath.keys()) visit(resourcePath);
  return cycles;
}

export async function buildGodotDependencyGraph(context, {
  workspaceId,
  projectSubpath,
  entryPaths = [],
  includeAllScenes = false,
  reverseTarget = '',
  maxNodes = 1000,
  maxDepth = 20
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: false });
  const projectText = await fsp.readFile(project.projectFile, 'utf8');
  const metadata = projectMetadata(projectText);
  const scan = await scanProject(project.root, Math.max(1000, Math.min(10000, maxNodes * 4)));
  const entries = [];
  for (const value of entryPaths) {
    const normalized = normalizeResourcePath(value);
    if (normalized) entries.push(normalized);
  }
  if (!entries.length && metadata.mainScene) {
    const normalizedMain = normalizeResourcePath(metadata.mainScene);
    if (normalizedMain) entries.push(normalizedMain);
  }
  if (includeAllScenes || !entries.length) {
    for (const scene of scan.samples.scenes) {
      const normalized = normalizeResourcePath(scene);
      if (normalized) entries.push(normalized);
    }
  }
  const queue = [...new Set(entries)].map(resourcePath => ({ resourcePath, depth: 0 }));
  const nodes = new Map();
  let truncated = false;
  while (queue.length) {
    const { resourcePath, depth } = queue.shift();
    if (nodes.has(resourcePath)) continue;
    if (nodes.size >= Math.min(5000, Math.max(1, Number(maxNodes) || 1000))) { truncated = true; break; }
    const loaded = await readTextResource(project.root, resourcePath);
    const references = loaded.text ? extractGodotReferences(loaded.text) : [];
    const sceneNodes = loaded.text && resourceType(resourcePath) === 'scene' ? parseSceneNodes(loaded.text) : [];
    nodes.set(resourcePath, {
      path: resourcePath,
      type: resourceType(resourcePath),
      exists: loaded.exists,
      size: loaded.size,
      tooLarge: loaded.tooLarge,
      depth,
      references,
      scene: sceneNodes.length ? {
        nodeCount: sceneNodes.length,
        root: sceneNodes[0] || null,
        types: Object.entries(sceneNodes.reduce((acc, item) => {
          const key = item.type || 'instanced';
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {})).sort((a, b) => b[1] - a[1]).slice(0, 50),
        sample: sceneNodes.slice(0, 100)
      } : null
    });
    if (depth >= Math.min(100, Math.max(0, Number(maxDepth) || 20))) {
      if (references.length) truncated = true;
      continue;
    }
    for (const target of references) if (!nodes.has(target)) queue.push({ resourcePath: target, depth: depth + 1 });
  }
  const reverse = new Map();
  for (const node of nodes.values()) {
    for (const target of node.references) {
      if (!reverse.has(target)) reverse.set(target, []);
      reverse.get(target).push(node.path);
    }
  }
  const missing = [...nodes.values()].filter(item => !item.exists).map(item => item.path);
  const cycles = findCycles(nodes);
  const normalizedReverseTarget = normalizeResourcePath(reverseTarget);
  return {
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    entries: [...new Set(entries)],
    summary: {
      nodes: nodes.size,
      edges: [...nodes.values()].reduce((sum, item) => sum + item.references.length, 0),
      missing: missing.length,
      cycles: cycles.length,
      scenes: [...nodes.values()].filter(item => item.type === 'scene').length,
      truncated
    },
    missing,
    cycles,
    reverseTarget: normalizedReverseTarget ? {
      path: normalizedReverseTarget,
      referencedBy: (reverse.get(normalizedReverseTarget) || []).sort()
    } : null,
    nodes: [...nodes.values()].sort((a, b) => a.path.localeCompare(b.path))
  };
}

export const __test = { normalizeResourcePath, parseAttributes, resourceType };
