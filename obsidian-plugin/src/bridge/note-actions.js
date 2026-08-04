'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { TFile } = require('obsidian');
const { MAX_BACKUP_BYTES } = require('./constants.js');
const { cleanVaultPath, propertyKey } = require('./path-policy.js');
const { publicOperation } = require('./operation-store.js');

function now() {
  return new Date().toISOString();
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
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

async function fileSnapshot(vault, file, { includeContent = true } = {}) {
  const content = await vault.read(file);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (includeContent && bytes > MAX_BACKUP_BYTES) {
    throw new Error(`Note exceeds the ${MAX_BACKUP_BYTES} byte rollback limit`);
  }
  return {
    ...(includeContent ? { content } : {}),
    hash: hash(content),
    mtime: file.stat.mtime,
    size: file.stat.size,
    bytes
  };
}

function requireMarkdownFile(vault, filePath) {
  const normalized = cleanVaultPath(filePath, { markdown: true });
  const file = vault.getAbstractFileByPath(normalized);
  if (!(file instanceof TFile) || file.extension !== 'md') throw new Error(`Markdown note not found: ${normalized}`);
  return file;
}

function normalizePropertyChange(args = {}) {
  const requestedSet = args.set && typeof args.set === 'object' && !Array.isArray(args.set) ? args.set : {};
  const set = Object.fromEntries(Object.entries(requestedSet).map(([key, value]) => [propertyKey(key), value]));
  const remove = [...new Set((Array.isArray(args.remove) ? args.remove : []).map(propertyKey))];
  if (!Object.keys(set).length && !remove.length) throw new Error('Provide at least one property to set or remove');
  return { set, remove };
}

async function createNote(plugin, operationStore, args = {}, metadata = {}) {
  const notePath = cleanVaultPath(args.path, { markdown: true });
  if (plugin.app.vault.getAbstractFileByPath(notePath)) throw new Error(`Path already exists: ${notePath}`);
  await mkdirParents(plugin.app.vault, notePath);
  const content = String(args.content || '');
  const file = await plugin.app.vault.create(notePath, content);
  const record = {
    id: operationStore.createId(),
    action: 'create_note',
    path: notePath,
    batchPlanId: metadata.batchPlanId || null,
    createdAt: now(),
    before: { existed: false },
    after: { hash: hash(content), mtime: file.stat.mtime }
  };
  operationStore.write(record);
  return { created: true, path: file.path, operation: publicOperation(record) };
}

async function updateProperties(plugin, operationStore, args = {}, metadata = {}) {
  const file = requireMarkdownFile(plugin.app.vault, args.path);
  const before = await fileSnapshot(plugin.app.vault, file);
  const { set, remove } = normalizePropertyChange(args);
  await plugin.app.fileManager.processFrontMatter(file, frontmatter => {
    for (const [key, value] of Object.entries(set)) frontmatter[key] = value;
    for (const key of remove) delete frontmatter[key];
  });
  const current = requireMarkdownFile(plugin.app.vault, file.path);
  const after = await fileSnapshot(plugin.app.vault, current, { includeContent: false });
  const record = {
    id: operationStore.createId(),
    action: 'update_properties',
    path: file.path,
    batchPlanId: metadata.batchPlanId || null,
    createdAt: now(),
    before,
    after,
    change: { set, remove }
  };
  operationStore.write(record);
  return { updated: true, path: file.path, set: Object.keys(set), removed: remove, operation: publicOperation(record) };
}

async function moveNote(plugin, operationStore, args = {}, metadata = {}) {
  const file = requireMarkdownFile(plugin.app.vault, args.path);
  const destination = cleanVaultPath(args.destination, { markdown: true });
  if (plugin.app.vault.getAbstractFileByPath(destination)) throw new Error(`Destination already exists: ${destination}`);
  const originalPath = file.path;
  const before = await fileSnapshot(plugin.app.vault, file, { includeContent: false });
  await mkdirParents(plugin.app.vault, destination);
  await plugin.app.fileManager.renameFile(file, destination);
  const moved = requireMarkdownFile(plugin.app.vault, destination);
  const after = await fileSnapshot(plugin.app.vault, moved, { includeContent: false });
  const record = {
    id: operationStore.createId(),
    action: 'move_note',
    path: originalPath,
    destination,
    batchPlanId: metadata.batchPlanId || null,
    createdAt: now(),
    before,
    after
  };
  operationStore.write(record);
  return { moved: true, from: originalPath, to: destination, operation: publicOperation(record) };
}

async function trashNote(plugin, operationStore, args = {}, metadata = {}) {
  const file = requireMarkdownFile(plugin.app.vault, args.path);
  const before = await fileSnapshot(plugin.app.vault, file);
  const originalPath = file.path;
  await plugin.app.fileManager.trashFile(file);
  const record = {
    id: operationStore.createId(),
    action: 'trash_note',
    path: originalPath,
    batchPlanId: metadata.batchPlanId || null,
    createdAt: now(),
    before,
    after: { existed: false }
  };
  operationStore.write(record);
  return { trashed: true, path: originalPath, operation: publicOperation(record) };
}

async function rollbackOperation(plugin, operationStore, args = {}) {
  const record = operationStore.read(args.operationId);
  if (record.rolledBackAt) {
    return { rolledBack: false, alreadyRolledBack: true, operation: publicOperation(record) };
  }
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
  operationStore.write(record);
  return { rolledBack: true, operation: publicOperation(record) };
}

module.exports = {
  createNote,
  fileSnapshot,
  hash,
  mkdirParents,
  moveNote,
  normalizePropertyChange,
  now,
  requireMarkdownFile,
  rollbackOperation,
  trashNote,
  updateProperties
};
