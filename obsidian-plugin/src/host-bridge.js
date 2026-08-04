'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { normalizePath, TFile } = require('obsidian');
const { updateConfig } = require('../../host/runtime-controller.js');

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_AUDIT_ITEMS = 500;
const MAX_OPERATION_RECORDS = 200;
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

function now() {
  return new Date().toISOString();
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function operationId() {
  return `obs_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

function cleanVaultPath(value, { markdown = false } = {}) {
  const raw = String(value || '').trim().replace(/^[/\\]+/, '');
  if (!raw) throw new Error('A vault-relative path is required');
  const normalized = normalizePath(raw);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('Path must remain inside the vault');
  }
  if (normalized === '.obsidian' || normalized.startsWith('.obsidian/')) {
    throw new Error('DevMate does not modify Obsidian internal configuration');
  }
  if (markdown && !normalized.toLowerCase().endsWith('.md')) return `${normalized}.md`;
  return normalized;
}

function withinFolder(filePath, folder = '') {
  const root = String(folder || '').trim() ? cleanVaultPath(folder) : '';
  return !root || filePath === root || filePath.startsWith(`${root}/`);
}

function jsonResponse(response, status, value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(payload);
}

async function requestJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error(`Request exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const value = text ? JSON.parse(text) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be a JSON object');
  return value;
}

function mkdirParents(vault, filePath) {
  const parent = path.posix.dirname(filePath);
  if (!parent || parent === '.') return Promise.resolve();
  const segments = parent.split('/');
  let current = '';
  return segments.reduce((promise, segment) => promise.then(async () => {
    current = current ? `${current}/${segment}` : segment;
    if (!vault.getAbstractFileByPath(current)) await vault.createFolder(current);
  }), Promise.resolve());
}

function operationDirectory(controller) {
  return path.join(controller.stateDirectory, 'host-operations', 'obsidian');
}

function cleanOperationId(value) {
  const id = String(value || '').trim();
  if (!/^obs_[a-z0-9_]{8,100}$/i.test(id)) throw new Error('Invalid Obsidian operation ID');
  return id;
}

function operationFile(controller, id) {
  return path.join(operationDirectory(controller), `${cleanOperationId(id)}.json`);
}

function writeOperation(controller, record) {
  const directory = operationDirectory(controller);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = operationFile(controller, record.id);
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
  try { fs.chmodSync(target, 0o600); } catch {}
  const records = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => {
      const file = path.join(directory, entry.name);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      return stat ? { file, mtimeMs: stat.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const stale of records.slice(MAX_OPERATION_RECORDS)) {
    try { fs.rmSync(stale.file, { force: true }); } catch {}
  }
}

function readOperation(controller, id) {
  const file = operationFile(controller, String(id || '').trim());
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid operation record');
  return parsed;
}

function publicOperation(record) {
  return {
    id: record.id,
    action: record.action,
    path: record.path || null,
    destination: record.destination || null,
    createdAt: record.createdAt,
    rolledBackAt: record.rolledBackAt || null
  };
}

function listOperations(controller, limit = 50) {
  const directory = operationDirectory(controller);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => {
      try { return readOperation(controller, entry.name.slice(0, -5)); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
    .map(publicOperation);
}

async function fileSnapshot(vault, file) {
  const content = await vault.read(file);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_BACKUP_BYTES) throw new Error(`Note exceeds the ${MAX_BACKUP_BYTES} byte rollback limit`);
  return {
    content,
    hash: hash(content),
    mtime: file.stat.mtime,
    size: file.stat.size,
    bytes
  };
}

function propertyKey(value) {
  const key = String(value || '').trim();
  if (!key || key.length > 200 || ['__proto__', 'prototype', 'constructor'].includes(key)) {
    throw new Error(`Invalid Obsidian property name: ${key || '(empty)'}`);
  }
  return key;
}

function requireMarkdownFile(vault, filePath) {
  const normalized = cleanVaultPath(filePath, { markdown: true });
  const file = vault.getAbstractFileByPath(normalized);
  if (!(file instanceof TFile) || file.extension !== 'md') throw new Error(`Markdown note not found: ${normalized}`);
  return file;
}

async function auditVault(plugin, args = {}) {
  const folder = String(args.folder || '').trim();
  const requiredProperties = [...new Set((Array.isArray(args.requiredProperties) ? args.requiredProperties : [])
    .map(propertyKey))].slice(0, 50);
  const files = plugin.app.vault.getMarkdownFiles().filter(file => withinFolder(file.path, folder));
  const inbound = new Map(files.map(file => [file.path, 0]));
  const resolved = plugin.app.metadataCache.resolvedLinks || {};
  for (const destinations of Object.values(resolved)) {
    for (const destination of Object.keys(destinations || {})) {
      if (inbound.has(destination)) inbound.set(destination, (inbound.get(destination) || 0) + 1);
    }
  }
  const unresolved = plugin.app.metadataCache.unresolvedLinks || {};
  const brokenLinks = [];
  for (const [source, destinations] of Object.entries(unresolved)) {
    if (!withinFolder(source, folder)) continue;
    for (const [destination, count] of Object.entries(destinations || {})) {
      brokenLinks.push({ source, destination, count });
      if (brokenLinks.length >= MAX_AUDIT_ITEMS) break;
    }
    if (brokenLinks.length >= MAX_AUDIT_ITEMS) break;
  }
  const missingProperties = [];
  const duplicateBasenames = new Map();
  for (const file of files) {
    const cache = plugin.app.metadataCache.getFileCache(file) || {};
    const frontmatter = cache.frontmatter || {};
    const missing = requiredProperties.filter(key => frontmatter[key] === undefined || frontmatter[key] === null || frontmatter[key] === '');
    if (missing.length && missingProperties.length < MAX_AUDIT_ITEMS) missingProperties.push({ path: file.path, missing });
    const key = file.basename.toLowerCase();
    const group = duplicateBasenames.get(key) || [];
    group.push(file.path);
    duplicateBasenames.set(key, group);
  }
  const orphanNotes = files.filter(file => (inbound.get(file.path) || 0) === 0).map(file => file.path);
  return {
    folder: folder ? cleanVaultPath(folder) : null,
    files: files.length,
    requiredProperties,
    orphanNotes: orphanNotes.slice(0, MAX_AUDIT_ITEMS),
    brokenLinks,
    missingProperties,
    duplicateBasenames: [...duplicateBasenames.values()].filter(group => group.length > 1).slice(0, MAX_AUDIT_ITEMS),
    truncated: {
      orphanNotes: orphanNotes.length > MAX_AUDIT_ITEMS,
      brokenLinks: brokenLinks.length >= MAX_AUDIT_ITEMS,
      missingProperties: missingProperties.length >= MAX_AUDIT_ITEMS
    }
  };
}

async function createNote(plugin, controller, args = {}) {
  const notePath = cleanVaultPath(args.path, { markdown: true });
  if (plugin.app.vault.getAbstractFileByPath(notePath)) throw new Error(`Path already exists: ${notePath}`);
  await mkdirParents(plugin.app.vault, notePath);
  const content = String(args.content || '');
  const file = await plugin.app.vault.create(notePath, content);
  const id = operationId();
  const record = {
    id,
    action: 'create_note',
    path: notePath,
    createdAt: now(),
    before: { existed: false },
    after: { hash: hash(content), mtime: file.stat.mtime }
  };
  writeOperation(controller, record);
  return { created: true, path: file.path, operation: publicOperation(record) };
}

async function updateProperties(plugin, controller, args = {}) {
  const file = requireMarkdownFile(plugin.app.vault, args.path);
  const before = await fileSnapshot(plugin.app.vault, file);
  const requestedSet = args.set && typeof args.set === 'object' && !Array.isArray(args.set) ? args.set : {};
  const set = Object.fromEntries(Object.entries(requestedSet).map(([key, value]) => [propertyKey(key), value]));
  const remove = [...new Set((Array.isArray(args.remove) ? args.remove : []).map(propertyKey))];
  if (!Object.keys(set).length && !remove.length) throw new Error('Provide at least one property to set or remove');
  await plugin.app.fileManager.processFrontMatter(file, frontmatter => {
    for (const [key, value] of Object.entries(set)) frontmatter[key] = value;
    for (const key of remove) delete frontmatter[key];
  });
  const current = requireMarkdownFile(plugin.app.vault, file.path);
  const after = await fileSnapshot(plugin.app.vault, current);
  const id = operationId();
  const record = {
    id,
    action: 'update_properties',
    path: file.path,
    createdAt: now(),
    before,
    after,
    change: { set, remove }
  };
  writeOperation(controller, record);
  return { updated: true, path: file.path, set: Object.keys(set), removed: remove, operation: publicOperation(record) };
}

async function moveNote(plugin, controller, args = {}) {
  const file = requireMarkdownFile(plugin.app.vault, args.path);
  const destination = cleanVaultPath(args.destination, { markdown: true });
  if (plugin.app.vault.getAbstractFileByPath(destination)) throw new Error(`Destination already exists: ${destination}`);
  const originalPath = file.path;
  const before = await fileSnapshot(plugin.app.vault, file);
  await mkdirParents(plugin.app.vault, destination);
  await plugin.app.fileManager.renameFile(file, destination);
  const moved = requireMarkdownFile(plugin.app.vault, destination);
  const after = await fileSnapshot(plugin.app.vault, moved);
  const id = operationId();
  const record = {
    id,
    action: 'move_note',
    path: originalPath,
    destination,
    createdAt: now(),
    before,
    after
  };
  writeOperation(controller, record);
  return { moved: true, from: originalPath, to: destination, operation: publicOperation(record) };
}

async function trashNote(plugin, controller, args = {}) {
  const file = requireMarkdownFile(plugin.app.vault, args.path);
  const before = await fileSnapshot(plugin.app.vault, file);
  const originalPath = file.path;
  await plugin.app.fileManager.trashFile(file);
  const id = operationId();
  const record = {
    id,
    action: 'trash_note',
    path: originalPath,
    createdAt: now(),
    before,
    after: { existed: false }
  };
  writeOperation(controller, record);
  return { trashed: true, path: originalPath, operation: publicOperation(record) };
}

async function rollbackOperation(plugin, controller, args = {}) {
  const record = readOperation(controller, args.operationId);
  if (record.rolledBackAt) throw new Error(`Operation was already rolled back at ${record.rolledBackAt}`);
  const force = args.force === true;
  const vault = plugin.app.vault;

  if (record.action === 'create_note') {
    const file = requireMarkdownFile(vault, record.path);
    const current = await fileSnapshot(vault, file);
    if (!force && current.hash !== record.after.hash) throw new Error('Created note changed after the operation; pass force=true to trash it');
    await plugin.app.fileManager.trashFile(file);
  } else if (record.action === 'update_properties') {
    const file = requireMarkdownFile(vault, record.path);
    const current = await fileSnapshot(vault, file);
    if (!force && current.hash !== record.after.hash) throw new Error('Note changed after the operation; pass force=true to restore the backup');
    await vault.process(file, content => {
      if (!force && hash(content) !== record.after.hash) throw new Error('Note changed during rollback');
      return record.before.content;
    });
  } else if (record.action === 'move_note') {
    if (vault.getAbstractFileByPath(record.path)) throw new Error(`Original path is occupied: ${record.path}`);
    const file = requireMarkdownFile(vault, record.destination);
    const current = await fileSnapshot(vault, file);
    if (!force && current.hash !== record.after.hash) throw new Error('Moved note changed after the operation; pass force=true to move it back');
    await mkdirParents(vault, record.path);
    await plugin.app.fileManager.renameFile(file, record.path);
  } else if (record.action === 'trash_note') {
    if (vault.getAbstractFileByPath(record.path)) throw new Error(`Original path is occupied: ${record.path}`);
    await mkdirParents(vault, record.path);
    await vault.create(record.path, record.before.content);
  } else {
    throw new Error(`Unsupported operation type: ${record.action}`);
  }

  record.rolledBackAt = now();
  writeOperation(controller, record);
  return { rolledBack: true, operation: publicOperation(record) };
}

class ObsidianHostBridge {
  constructor(plugin, controller) {
    this.plugin = plugin;
    this.controller = controller;
    this.server = null;
    this.token = crypto.randomBytes(32).toString('base64url');
    this.url = '';
  }

  async action(action, args) {
    switch (action) {
      case 'status': return { available: true, vault: this.plugin.app.vault.getName(), root: this.plugin.vaultRoot };
      case 'audit_vault': return auditVault(this.plugin, args);
      case 'create_note': return createNote(this.plugin, this.controller, args);
      case 'update_properties': return updateProperties(this.plugin, this.controller, args);
      case 'move_note': return moveNote(this.plugin, this.controller, args);
      case 'trash_note': return trashNote(this.plugin, this.controller, args);
      case 'operation_list': return { operations: listOperations(this.controller, args.limit) };
      case 'operation_rollback': return rollbackOperation(this.plugin, this.controller, args);
      default: throw new Error(`Unsupported Obsidian action: ${action}`);
    }
  }

  async handle(request, response) {
    if (request.method !== 'POST' || request.url !== '/v1/action') {
      jsonResponse(response, 404, { ok: false, error: 'not_found' });
      return;
    }
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      jsonResponse(response, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      jsonResponse(response, 415, { ok: false, error: 'application_json_required' });
      return;
    }
    try {
      const body = await requestJson(request);
      const result = await this.action(String(body.action || ''), body.args || {});
      jsonResponse(response, 200, { ok: true, result });
    } catch (error) {
      jsonResponse(response, 400, { ok: false, error: error.message || String(error) });
    }
  }

  async start() {
    if (this.server) return { url: this.url };
    this.server = http.createServer((request, response) => this.handle(request, response));
    this.server.maxConnections = 16;
    this.server.keepAliveTimeout = 5000;
    this.server.headersTimeout = 7000;
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    this.url = `http://127.0.0.1:${address.port}`;
    updateConfig(this.controller.configFile, config => {
      config.hostBridges ||= {};
      config.hostBridges.obsidian = {
        url: this.url,
        token: this.token,
        pid: process.pid,
        updatedAt: now(),
        workspaceRoot: this.plugin.vaultRoot
      };
      return config;
    });
    return { url: this.url };
  }

  async stop() {
    const token = this.token;
    try {
      updateConfig(this.controller.configFile, config => {
        if (config.hostBridges?.obsidian?.token === token) delete config.hostBridges.obsidian;
        return config;
      });
    } catch {}
    const server = this.server;
    this.server = null;
    this.url = '';
    if (!server) return;
    await new Promise(resolve => server.close(resolve));
  }
}

module.exports = {
  ObsidianHostBridge,
  __test: {
    cleanOperationId,
    cleanVaultPath,
    hash,
    propertyKey,
    publicOperation,
    withinFolder
  }
};
