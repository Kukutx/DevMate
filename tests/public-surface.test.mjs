import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { DevMateService } from '../runtime/service.mjs';
import { MODEL_VISIBLE_OPERATIONS, toolAnnotations } from '../runtime/mcp.mjs';

// The names a connected model and a person's scripts depend on: every tool with its parameters and with what a
// client is told about it (whether it only reads, may destroy, reaches outside), and every operation. Clients decide
// from those hints whether to ask the person first, so a hint that changes by accident changes what gets confirmed. A difference here is a change of the public surface (README, "Compatibility"). Make it on purpose,
// say so in the changelog, then record it:  node tests/public-surface.test.mjs --update
const recorded = new URL('./fixtures/public-surface.json', import.meta.url);

test('the tools a model sees and the operations scripts call are the recorded ones', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-surface-'));
  const service = new DevMateService({ instanceRoot: directory, endpoint: '' });
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await service.ready;
  const connected = { id: 'owner', role: 'owner', projectIds: null };
  const tools = {};
  for (const operation of service.visibleOperations(connected)) {
    if (!MODEL_VISIBLE_OPERATIONS.has(operation.name) || operation.localOnly) continue;
    // The idempotency key of scripted callers is not part of a tool.
    const schema = z.toJSONSchema(operation.schema.shape.operationId ? operation.schema.omit({ operationId: true }) : operation.schema);
    tools[operation.name.replaceAll('.', '_')] = { parameters: Object.keys(schema.properties || {}).sort(), required: [...(schema.required || [])].sort(), ...toolAnnotations(operation) };
  }
  const surface = { tools: Object.fromEntries(Object.entries(tools).sort(([a], [b]) => a.localeCompare(b))), operations: [...service.operations.keys()].sort() };
  if (process.argv.includes('--update')) { fs.mkdirSync(new URL('.', recorded), { recursive: true }); fs.writeFileSync(recorded, JSON.stringify(surface, null, 2) + '\n'); return; }
  assert.deepEqual(surface, JSON.parse(fs.readFileSync(recorded, 'utf8')),
    'The public surface changed. If that is intended, list it in the changelog and run: node tests/public-surface.test.mjs --update');
});
