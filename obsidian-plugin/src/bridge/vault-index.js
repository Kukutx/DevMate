'use strict';

const { getAllTags, TFile } = require('obsidian');
const { MAX_RESPONSE_ITEMS } = require('./constants.js');
const { cleanFolderPath, propertyKey } = require('./path-policy.js');
const {
  normalizeSelector,
  publicRecord,
  recordMatchesSelector,
  safeFrontmatter,
  schemaFromRecords,
  sortRecords,
  uniqueStrings
} = require('./vault-index-core.js');

class VaultIndex {
  constructor(plugin) {
    this.plugin = plugin;
    this.records = new Map();
    this.events = [];
    this.started = false;
    this.graphDirty = true;
    this.refreshedAt = null;
    this.generation = 0;
  }

  metadataRecord(file) {
    const cache = this.plugin.app.metadataCache.getFileCache(file) || {};
    const tags = uniqueStrings(getAllTags(cache) || [], item => {
      const tag = String(item || '').trim();
      return tag && (tag.startsWith('#') ? tag : `#${tag}`);
    }, 500);
    return {
      path: file.path,
      name: file.basename,
      folder: file.parent?.path || '',
      extension: file.extension,
      createdAtMs: file.stat.ctime,
      modifiedAtMs: file.stat.mtime,
      createdAt: new Date(file.stat.ctime).toISOString(),
      modifiedAt: new Date(file.stat.mtime).toISOString(),
      size: file.stat.size,
      properties: safeFrontmatter(cache.frontmatter),
      tags,
      headings: (cache.headings || []).slice(0, 200).map(item => ({ heading: item.heading, level: item.level })),
      resolvedLinks: 0,
      unresolvedLinks: 0,
      inboundLinks: 0,
      embeds: (cache.embeds || []).length
    };
  }

  upsert(file) {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    this.records.set(file.path, this.metadataRecord(file));
    this.graphDirty = true;
    this.generation += 1;
  }

  remove(path) {
    if (this.records.delete(String(path || ''))) {
      this.graphDirty = true;
      this.generation += 1;
    }
  }

  refreshAll() {
    this.records.clear();
    for (const file of this.plugin.app.vault.getMarkdownFiles()) this.upsert(file);
    this.graphDirty = true;
    this.refreshedAt = new Date().toISOString();
  }

  addEvent(emitter, ref) {
    this.events.push({ emitter, ref });
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.refreshAll();
    const vault = this.plugin.app.vault;
    const metadata = this.plugin.app.metadataCache;
    this.addEvent(vault, vault.on('create', file => this.upsert(file)));
    this.addEvent(vault, vault.on('delete', file => this.remove(file.path)));
    this.addEvent(vault, vault.on('rename', (file, oldPath) => {
      this.remove(oldPath);
      this.upsert(file);
    }));
    this.addEvent(metadata, metadata.on('changed', file => this.upsert(file)));
  }

  stop() {
    for (const { emitter, ref } of this.events.splice(0)) {
      try { emitter.offref(ref); } catch {}
    }
    this.started = false;
  }

  rebuildLinkMetrics() {
    for (const record of this.records.values()) {
      record.resolvedLinks = 0;
      record.unresolvedLinks = 0;
      record.inboundLinks = 0;
    }
    const resolved = this.plugin.app.metadataCache.resolvedLinks || {};
    for (const [source, destinations] of Object.entries(resolved)) {
      const sourceRecord = this.records.get(source);
      if (sourceRecord) sourceRecord.resolvedLinks = Object.keys(destinations || {}).length;
      for (const [destination, count] of Object.entries(destinations || {})) {
        const target = this.records.get(destination);
        if (target) target.inboundLinks += Math.max(1, Number(count) || 1);
      }
    }
    const unresolved = this.plugin.app.metadataCache.unresolvedLinks || {};
    for (const [source, destinations] of Object.entries(unresolved)) {
      const record = this.records.get(source);
      if (record) record.unresolvedLinks = Object.values(destinations || {})
        .reduce((total, count) => total + Math.max(1, Number(count) || 1), 0);
    }
    this.graphDirty = false;
  }

  ensureFresh() {
    if (!this.started && !this.records.size) this.refreshAll();
    if (this.graphDirty) this.rebuildLinkMetrics();
  }

  selectedRecords(args = {}) {
    this.ensureFresh();
    const selector = normalizeSelector(args);
    return [...this.records.values()].filter(record => recordMatchesSelector(record, selector));
  }

  query(args = {}) {
    const records = sortRecords(this.selectedRecords(args), args.sort, args.order);
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Math.min(MAX_RESPONSE_ITEMS, Number(args.limit) || 100));
    const page = records.slice(offset, offset + limit);
    return {
      generation: this.generation,
      refreshedAt: this.refreshedAt,
      total: records.length,
      offset,
      limit,
      nextOffset: offset + page.length < records.length ? offset + page.length : null,
      items: page.map(record => publicRecord(record, { includeProperties: args.includeProperties !== false }))
    };
  }

  schema(args = {}) {
    return {
      selector: args,
      ...schemaFromRecords(this.selectedRecords(args), { examplesPerProperty: Math.max(1, Math.min(10, Number(args.examplesPerProperty) || 5)) })
    };
  }

  audit(args = {}) {
    const records = this.selectedRecords(args);
    const requiredProperties = uniqueStrings(args.requiredProperties, propertyKey, 50);
    const missingProperties = [];
    const duplicateBasenames = new Map();
    const brokenLinks = [];
    const unresolved = this.plugin.app.metadataCache.unresolvedLinks || {};
    for (const record of records) {
      const missing = requiredProperties.filter(key =>
        record.properties[key] === undefined || record.properties[key] === null || record.properties[key] === ''
      );
      if (missing.length && missingProperties.length < MAX_RESPONSE_ITEMS) missingProperties.push({ path: record.path, missing });
      const key = record.name.toLowerCase();
      const group = duplicateBasenames.get(key) || [];
      group.push(record.path);
      duplicateBasenames.set(key, group);
      for (const [destination, count] of Object.entries(unresolved[record.path] || {})) {
        brokenLinks.push({ source: record.path, destination, count });
        if (brokenLinks.length >= MAX_RESPONSE_ITEMS) break;
      }
    }
    const orphanNotes = records.filter(record => record.inboundLinks === 0).map(record => record.path);
    return {
      folder: args.folder ? cleanFolderPath(args.folder) : null,
      files: records.length,
      requiredProperties,
      orphanNotes: orphanNotes.slice(0, MAX_RESPONSE_ITEMS),
      brokenLinks: brokenLinks.slice(0, MAX_RESPONSE_ITEMS),
      missingProperties,
      duplicateBasenames: [...duplicateBasenames.values()].filter(group => group.length > 1).slice(0, MAX_RESPONSE_ITEMS),
      truncated: {
        orphanNotes: orphanNotes.length > MAX_RESPONSE_ITEMS,
        brokenLinks: brokenLinks.length > MAX_RESPONSE_ITEMS,
        missingProperties: missingProperties.length >= MAX_RESPONSE_ITEMS
      }
    };
  }
}

module.exports = { VaultIndex };
