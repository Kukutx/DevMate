'use strict';

const { MAX_RESPONSE_ITEMS } = require('./constants.js');
const {
  cleanFolderPath,
  cleanVaultPath,
  normalizeTag,
  propertyKey,
  withinFolder
} = require('./path-policy.js');

function safeFrontmatter(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'position') continue;
    output[key] = item;
  }
  return output;
}

function propertyType(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'list';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[T ][^\s]+)?$/.test(value)) return 'date-string';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function propertyEquals(left, right) {
  if (Object.is(left, right)) return true;
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return false; }
}

function uniqueStrings(value, normalize = item => String(item || '').trim(), max = 200) {
  const input = Array.isArray(value) ? value : [];
  return [...new Set(input.map(normalize).filter(Boolean))].slice(0, max);
}

function normalizeSelector(args = {}) {
  const properties = args.properties && typeof args.properties === 'object' && !Array.isArray(args.properties)
    ? Object.fromEntries(Object.entries(args.properties).map(([key, value]) => [propertyKey(key), value]))
    : {};
  const paths = uniqueStrings(args.paths, item => cleanVaultPath(item, { markdown: true }), MAX_RESPONSE_ITEMS);
  return {
    folder: cleanFolderPath(args.folder || ''),
    paths,
    pathSet: new Set(paths),
    tagsAll: uniqueStrings(args.tagsAll || args.tags, normalizeTag, 100),
    tagsAny: uniqueStrings(args.tagsAny, normalizeTag, 100),
    propertyExists: uniqueStrings(args.propertyExists, propertyKey, 100),
    propertyMissing: uniqueStrings(args.propertyMissing, propertyKey, 100),
    properties,
    search: String(args.search || '').trim().toLowerCase(),
    modifiedAfter: args.modifiedAfter ? Date.parse(args.modifiedAfter) : null,
    modifiedBefore: args.modifiedBefore ? Date.parse(args.modifiedBefore) : null
  };
}

function recordSearchText(record) {
  let properties = '';
  try { properties = JSON.stringify(record.properties); } catch {}
  return `${record.path}\n${record.name}\n${record.tags.join(' ')}\n${properties}`.toLowerCase();
}

function recordMatchesSelector(record, selector) {
  if (selector.folder && !withinFolder(record.path, selector.folder)) return false;
  if (selector.pathSet.size && !selector.pathSet.has(record.path)) return false;
  if (selector.tagsAll.length && !selector.tagsAll.every(tag => record.tags.includes(tag))) return false;
  if (selector.tagsAny.length && !selector.tagsAny.some(tag => record.tags.includes(tag))) return false;
  if (selector.propertyExists.some(key => record.properties[key] === undefined || record.properties[key] === null)) return false;
  if (selector.propertyMissing.some(key => record.properties[key] !== undefined && record.properties[key] !== null)) return false;
  for (const [key, value] of Object.entries(selector.properties)) {
    if (!propertyEquals(record.properties[key], value)) return false;
  }
  if (selector.search && !recordSearchText(record).includes(selector.search)) return false;
  if (Number.isFinite(selector.modifiedAfter) && record.modifiedAtMs < selector.modifiedAfter) return false;
  if (Number.isFinite(selector.modifiedBefore) && record.modifiedAtMs > selector.modifiedBefore) return false;
  return true;
}

function sortRecords(records, sort = 'path', order = 'asc') {
  const direction = String(order).toLowerCase() === 'desc' ? -1 : 1;
  const key = ['path', 'name', 'modified', 'created', 'size'].includes(sort) ? sort : 'path';
  return [...records].sort((left, right) => {
    let a;
    let b;
    if (key === 'modified') { a = left.modifiedAtMs; b = right.modifiedAtMs; }
    else if (key === 'created') { a = left.createdAtMs; b = right.createdAtMs; }
    else if (key === 'size') { a = left.size; b = right.size; }
    else { a = String(left[key] || '').toLowerCase(); b = String(right[key] || '').toLowerCase(); }
    if (a < b) return -1 * direction;
    if (a > b) return 1 * direction;
    return left.path.localeCompare(right.path);
  });
}

function publicRecord(record, { includeProperties = true } = {}) {
  const output = {
    path: record.path,
    name: record.name,
    folder: record.folder,
    createdAt: record.createdAt,
    modifiedAt: record.modifiedAt,
    size: record.size,
    tags: record.tags,
    headings: record.headings,
    links: {
      inbound: record.inboundLinks,
      resolved: record.resolvedLinks,
      unresolved: record.unresolvedLinks,
      embeds: record.embeds
    }
  };
  if (includeProperties) output.properties = record.properties;
  return output;
}

function schemaFromRecords(records, { examplesPerProperty = 5 } = {}) {
  const stats = new Map();
  const tagCounts = new Map();
  const folderCounts = new Map();
  for (const record of records) {
    folderCounts.set(record.folder, (folderCounts.get(record.folder) || 0) + 1);
    for (const tag of record.tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    for (const [name, value] of Object.entries(record.properties)) {
      const stat = stats.get(name) || { name, present: 0, types: new Map(), examples: [] };
      stat.present += 1;
      const type = propertyType(value);
      stat.types.set(type, (stat.types.get(type) || 0) + 1);
      if (stat.examples.length < examplesPerProperty && !stat.examples.some(item => propertyEquals(item, value))) {
        stat.examples.push(value);
      }
      stats.set(name, stat);
    }
  }
  const properties = [...stats.values()].map(stat => {
    const types = Object.fromEntries([...stat.types.entries()].sort((left, right) => right[1] - left[1]));
    return {
      name: stat.name,
      present: stat.present,
      missing: Math.max(0, records.length - stat.present),
      coverage: records.length ? Number((stat.present / records.length).toFixed(4)) : 0,
      types,
      examples: stat.examples
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  return {
    files: records.length,
    properties,
    inconsistentTypes: properties.filter(item => Object.keys(item.types).filter(type => type !== 'null').length > 1),
    tags: [...tagCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 200)
      .map(([tag, count]) => ({ tag, count })),
    folders: [...folderCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 200)
      .map(([folder, count]) => ({ folder, count }))
  };
}

module.exports = {
  normalizeSelector,
  propertyEquals,
  propertyType,
  publicRecord,
  recordMatchesSelector,
  safeFrontmatter,
  schemaFromRecords,
  sortRecords,
  uniqueStrings
};
