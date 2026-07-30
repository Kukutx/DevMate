import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeSlash, readConfig } from './local-shared.mjs';

const BLOCKED_SEGMENTS = new Set(['.git', '.env', 'secrets', 'secret', 'credentials', 'credential', 'private-key', 'private_keys', 'service-account', 'service_accounts']);
const BLOCKED_EXTENSIONS = new Set(['.pem', '.key', '.pfx', '.p12', '.db', '.sqlite', '.sqlite3', '.log']);
const PATH_KEY = /(?:path|file|report|screenshot|output|artifact)s?$/i;

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function blocked(relativePath) {
  const parts = normalizeSlash(relativePath).split('/').filter(Boolean).map(value => value.toLowerCase());
  const base = parts.at(-1) || '';
  return parts.some(value => value.startsWith('.') || BLOCKED_SEGMENTS.has(value) || value.startsWith('.env.')) || BLOCKED_EXTENSIONS.has(path.extname(base));
}

function workspaceFor(job) {
  const config = readConfig();
  const workspace = (config.workspaces || []).find(item => item.id === job.workspaceId || item.name === job.workspaceId) || null;
  if (!workspace) throw new Error(`Workspace not found for job artifact indexing: ${job.workspaceId}`);
  return workspace;
}

function collectCandidateValues(value, key = '', depth = 0, output = []) {
  if (depth > 10 || value == null) return output;
  if (typeof value === 'string') {
    if (PATH_KEY.test(key) && value.length <= 2000) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) collectCandidateValues(item, key, depth + 1, output);
    return output;
  }
  if (typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value).slice(0, 500)) collectCandidateValues(child, childKey, depth + 1, output);
  }
  return output;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function fileRecord(workspace, workspaceReal, file) {
  let real;
  try { real = fs.realpathSync.native(file); } catch { return null; }
  if (!isInside(workspaceReal, real)) return null;
  const relative = normalizeSlash(path.relative(workspace.root, real));
  if (!relative || blocked(relative)) return null;
  const stat = await fsp.stat(real);
  if (!stat.isFile()) return null;
  return {
    workspaceId: workspace.id,
    path: relative,
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256: stat.size <= 128 * 1024 * 1024 ? await sha256File(real) : null
  };
}

async function artifactRecords(workspace, candidate, maxRecords = 100) {
  const text = String(candidate || '').trim();
  if (!text || /^(?:https?:|data:|blob:)/i.test(text)) return [];
  const full = path.isAbsolute(text) ? path.resolve(text) : path.resolve(workspace.root, text);
  if (!isInside(workspace.root, full)) return [];
  const workspaceReal = fs.realpathSync.native(workspace.root);
  let real;
  try { real = fs.realpathSync.native(full); } catch { return []; }
  if (!isInside(workspaceReal, real)) return [];
  const relative = normalizeSlash(path.relative(workspace.root, real));
  if (relative && blocked(relative)) return [];
  const stat = await fsp.stat(real);
  if (stat.isFile()) {
    const record = await fileRecord(workspace, workspaceReal, real);
    return record ? [record] : [];
  }
  if (!stat.isDirectory()) return [];

  const records = [];
  async function walk(directory, depth) {
    if (records.length >= maxRecords || depth > 8) return;
    let entries;
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (records.length >= maxRecords) break;
      const child = path.join(directory, entry.name);
      const childRelative = normalizeSlash(path.relative(workspace.root, child));
      if (blocked(childRelative)) continue;
      if (entry.isDirectory()) {
        await walk(child, depth + 1);
      } else if (entry.isFile()) {
        const record = await fileRecord(workspace, workspaceReal, child);
        if (record && !records.some(item => item.path === record.path)) records.push(record);
      }
    }
  }
  await walk(real, 0);
  return records;
}

export async function indexJobArtifacts(job, result) {
  if (!job.workspaceId) return [];
  const workspace = workspaceFor(job);
  const candidates = [
    ...(Array.isArray(job.artifactPaths) ? job.artifactPaths : []),
    ...collectCandidateValues(result?.structuredContent ?? result ?? {})
  ];
  const unique = [...new Set(candidates.map(value => String(value || '').trim()).filter(Boolean))].slice(0, 200);
  const records = [];
  for (const candidate of unique) {
    try {
      const found = await artifactRecords(workspace, candidate, 100 - records.length);
      for (const record of found) {
        if (!records.some(item => item.path === record.path)) records.push(record);
        if (records.length >= 100) break;
      }
    } catch {}
    if (records.length >= 100) break;
  }
  return records;
}

export const __test = { artifactRecords, blocked, collectCandidateValues, isInside };
