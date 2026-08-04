'use strict';

function normalizeSegments(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw) return [];
  const segments = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') throw new Error('Path must remain inside the vault');
    if (segment.includes('\0')) throw new Error('Path contains a null byte');
    segments.push(segment);
  }
  return segments;
}

function cleanVaultPath(value, { markdown = false, allowRoot = false } = {}) {
  const segments = normalizeSegments(value);
  if (!segments.length) {
    if (allowRoot) return '';
    throw new Error('A vault-relative path is required');
  }
  if (segments[0].toLowerCase() === '.obsidian') {
    throw new Error('DevMate does not modify Obsidian internal configuration');
  }
  let normalized = segments.join('/');
  if (markdown && !normalized.toLowerCase().endsWith('.md')) normalized = `${normalized}.md`;
  return normalized;
}

function cleanFolderPath(value) {
  return cleanVaultPath(value, { allowRoot: true });
}

function withinFolder(filePath, folder = '') {
  const root = cleanFolderPath(folder);
  return !root || filePath === root || filePath.startsWith(`${root}/`);
}

function cleanOperationId(value, prefix = 'obs') {
  const id = String(value || '').trim();
  const pattern = new RegExp(`^${prefix}_[a-z0-9_]{8,100}$`, 'i');
  if (!pattern.test(id)) throw new Error(`Invalid ${prefix} record ID`);
  return id;
}

function propertyKey(value) {
  const key = String(value || '').trim();
  if (!key || key.length > 200 || ['__proto__', 'prototype', 'constructor'].includes(key)) {
    throw new Error(`Invalid Obsidian property name: ${key || '(empty)'}`);
  }
  return key;
}

function normalizeTag(value) {
  const tag = String(value || '').trim();
  if (!tag) return '';
  return tag.startsWith('#') ? tag : `#${tag}`;
}

module.exports = {
  cleanFolderPath,
  cleanOperationId,
  cleanVaultPath,
  normalizeSegments,
  normalizeTag,
  propertyKey,
  withinFolder
};
