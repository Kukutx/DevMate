'use strict';

const { getAllTags, TFile } = require('obsidian');
const { MAX_RESPONSE_ITEMS } = require('./constants.js');
const { metadataScore, normalizeMode, searchDocument, tokenizeQuery } = require('./content-search-core.js');
const { cleanFolderPath, cleanVaultPath, propertyKey } = require('./path-policy.js');
const { buildVaultGraph } = require('./vault-graph-core.js');
const {
  normalizeSelector,
  publicRecord,
  recordMatchesSelector,
  safeFrontmatter,
  schemaFromRecords,
  sortRecords,
  uniqueStrings
} = require('./vault-index-core.js');

const MAX_CONTENT_CANDIDATES = 2000;
const MAX_CONTENT_RESULTS = 200;
const MAX_CONTENT_FILE_BYTES = 5 * 1024 * 1024;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

async function runBounded(items, concurrency, mapper) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await mapper(items[index], index);
    }
  }
  const count = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: count }, () => worker()));
}

class VaultIndex {
  constructor(plugin) {
    this.plugin = plugin;
    this.records = new Map();
    this.events = [];
    this.started = false;
    this.graphDirty = true;
    this.refreshedAt = null;
    this.lastGraphRebuildAt = null;
    this.lastContentSearch = null;
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
    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      this.records.set(file.path, this.metadataRecord(file));
    }
    this.graphDirty = true;
    this.refreshedAt = new Date().toISOString();
    this.generation += 1;
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
    this.lastGraphRebuildAt = new Date().toISOString();
  }

  ensureRecords() {
    if (!this.started && !this.records.size) this.refreshAll();
  }

  ensureFresh() {
    this.ensureRecords();
    if (this.graphDirty) this.rebuildLinkMetrics();
  }

  diagnostics() {
    this.ensureRecords();
    return {
      files: this.records.size,
      generation: this.generation,
      refreshedAt: this.refreshedAt,
      graphDirty: this.graphDirty,
      lastGraphRebuildAt: this.lastGraphRebuildAt,
      lastContentSearch: this.lastContentSearch
    };
  }

  selectedRecords(args = {}, { withLinks = false } = {}) {
    if (withLinks) this.ensureFresh();
    else this.ensureRecords();
    const selector = normalizeSelector(args);
    return [...this.records.values()].filter(record => recordMatchesSelector(record, selector));
  }

  query(args = {}) {
    const records = sortRecords(this.selectedRecords(args, { withLinks: true }), args.sort, args.order);
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

  async searchContent(args = {}) {
    const startedAt = Date.now();
    const query = String(args.query || '').trim();
    const mode = normalizeMode(args.mode);
    const caseSensitive = args.caseSensitive === true;
    const terms = tokenizeQuery(query, mode);
    const maxCandidates = boundedInteger(args.maxCandidates, 1000, 1, MAX_CONTENT_CANDIDATES);
    const limit = boundedInteger(args.limit, 50, 1, MAX_CONTENT_RESULTS);
    const snippetChars = boundedInteger(args.snippetChars, 280, 80, 1000);
    const maxFileBytes = boundedInteger(args.maxFileBytes, 1024 * 1024, 4096, MAX_CONTENT_FILE_BYTES);
    const concurrency = boundedInteger(args.concurrency, 8, 1, 16);
    const selected = sortRecords(this.selectedRecords(args), 'modified', 'desc');
    const candidates = selected.slice(0, maxCandidates);
    const matches = [];
    let filesRead = 0;
    let skippedLarge = 0;
    let skippedMissing = 0;
    let readErrors = 0;

    await runBounded(candidates, concurrency, async record => {
      if (record.size > maxFileBytes) {
        skippedLarge += 1;
        return;
      }
      const file = this.plugin.app.vault.getAbstractFileByPath(record.path);
      if (!(file instanceof TFile)) {
        skippedMissing += 1;
        return;
      }
      try {
        const content = await this.plugin.app.vault.cachedRead(file);
        filesRead += 1;
        const match = searchDocument(content, { query, mode, caseSensitive, snippetChars });
        if (!match.matched) return;
        matches.push({
          path: record.path,
          name: record.name,
          folder: record.folder,
          modifiedAt: record.modifiedAt,
          modifiedAtMs: record.modifiedAtMs,
          size: record.size,
          tags: record.tags,
          score: match.score + metadataScore(record, terms, caseSensitive),
          matchedTerms: match.matchedTerms,
          totalOccurrences: match.totalOccurrences,
          line: match.line,
          snippet: match.snippet
        });
      } catch {
        readErrors += 1;
      }
    });

    matches.sort((left, right) =>
      right.score - left.score || right.modifiedAtMs - left.modifiedAtMs || left.path.localeCompare(right.path)
    );
    const durationMs = Date.now() - startedAt;
    const items = matches.slice(0, limit).map(({ modifiedAtMs, ...item }) => item);
    this.lastContentSearch = {
      at: new Date().toISOString(),
      durationMs,
      selected: selected.length,
      candidates: candidates.length,
      filesRead,
      matches: matches.length,
      skippedLarge,
      skippedMissing,
      readErrors
    };
    return {
      generation: this.generation,
      refreshedAt: this.refreshedAt,
      query,
      mode,
      caseSensitive,
      total: matches.length,
      limit,
      items,
      stats: {
        durationMs,
        selected: selected.length,
        candidates: candidates.length,
        filesRead,
        skippedLarge,
        skippedMissing,
        readErrors
      },
      truncated: {
        candidates: selected.length > candidates.length,
        results: matches.length > items.length
      }
    };
  }

  graph(args = {}) {
    this.ensureRecords();
    const paths = uniqueStrings(args.paths, item => cleanVaultPath(item, { markdown: true }), 50);
    return {
      generation: this.generation,
      refreshedAt: this.refreshedAt,
      generatedAt: new Date().toISOString(),
      ...buildVaultGraph(this.records, this.plugin.app.metadataCache.resolvedLinks || {}, { ...args, paths })
    };
  }

  schema(args = {}) {
    return {
      selector: args,
      ...schemaFromRecords(this.selectedRecords(args), { examplesPerProperty: Math.max(1, Math.min(10, Number(args.examplesPerProperty) || 5)) })
    };
  }

  audit(args = {}) {
    const records = this.selectedRecords(args, { withLinks: true });
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

module.exports = { VaultIndex, __test: { boundedInteger, runBounded } };
