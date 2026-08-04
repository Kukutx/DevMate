'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

class FakeTFile {
  constructor(path, content, properties = {}) {
    this.path = path;
    this.extension = 'md';
    this.content = content;
    this.properties = { ...properties };
    this.stat = { mtime: Date.now(), size: Buffer.byteLength(content) };
  }
}

const originalLoad = Module._load;
Module._load = function loadWithObsidianStub(request, parent, isMain) {
  if (request === 'obsidian') return { TFile: FakeTFile };
  return originalLoad.call(this, request, parent, isMain);
};
const {
  applyPropertiesBatch,
  previewPropertiesBatch,
  rollbackPropertiesBatch
} = require('../obsidian-plugin/src/bridge/property-batch.js');
Module._load = originalLoad;

class MemoryStore {
  constructor(prefix) { this.prefix = prefix; this.counter = 0; this.records = new Map(); }
  createId() { return `${this.prefix}_abcdefgh_${++this.counter}`; }
  write(record) { this.records.set(record.id, structuredClone(record)); return record; }
  read(id) { return structuredClone(this.records.get(id)); }
}

function fixture() {
  const file = new FakeTFile('Projects/A.md', 'body', { status: 'active' });
  const files = new Map([[file.path, file]]);
  const vault = {
    getAbstractFileByPath(path) { return files.get(path) || null; },
    async read(target) { return target.content; },
    async process(target, mutator) {
      target.content = mutator(target.content);
      target.stat.mtime += 1;
      target.stat.size = Buffer.byteLength(target.content);
    }
  };
  const plugin = {
    app: {
      vault,
      fileManager: {
        async processFrontMatter(target, mutate) {
          mutate(target.properties);
          target.content = `${JSON.stringify(target.properties)}\nbody`;
          target.stat.mtime += 1;
          target.stat.size = Buffer.byteLength(target.content);
        }
      }
    }
  };
  const index = {
    selectedRecords() {
      return [{ path: file.path, properties: { ...file.properties } }];
    }
  };
  return { file, index, plugin };
}

test('previews, applies, retries, and rolls back a Property batch plan', async () => {
  const { file, index, plugin } = fixture();
  const operationStore = new MemoryStore('obs');
  const planStore = new MemoryStore('obp');
  const preview = await previewPropertiesBatch(plugin, index, planStore, {
    selector: { folder: 'Projects' },
    set: { status: 'done', priority: 1 }
  });
  assert.equal(preview.planned, true);
  assert.equal(preview.changed, 1);

  const applied = await applyPropertiesBatch(plugin, operationStore, planStore, { planId: preview.plan.id });
  assert.equal(applied.applied, true);
  assert.equal(file.properties.status, 'done');
  assert.equal(file.properties.priority, 1);

  const retried = await applyPropertiesBatch(plugin, operationStore, planStore, { planId: preview.plan.id });
  assert.equal(retried.alreadyApplied, true);
  assert.equal(operationStore.records.size, 1);
  const operation = [...operationStore.records.values()][0];
  assert.equal(operation.before.content, 'body');
  assert.equal(Object.hasOwn(operation.after, 'content'), false);

  const rolledBack = await rollbackPropertiesBatch(plugin, operationStore, planStore, { planId: preview.plan.id });
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(file.content, 'body');

  const retriedRollback = await rollbackPropertiesBatch(plugin, operationStore, planStore, { planId: preview.plan.id });
  assert.equal(retriedRollback.alreadyRolledBack, true);
});

test('rejects apply when a previewed note changes', async () => {
  const { file, index, plugin } = fixture();
  const operationStore = new MemoryStore('obs');
  const planStore = new MemoryStore('obp');
  const preview = await previewPropertiesBatch(plugin, index, planStore, { set: { status: 'done' } });
  file.content = 'changed outside DevMate';
  const result = await applyPropertiesBatch(plugin, operationStore, planStore, { planId: preview.plan.id });
  assert.equal(result.applied, false);
  assert.equal(result.status, 'conflict');
  assert.equal(operationStore.records.size, 0);
});
