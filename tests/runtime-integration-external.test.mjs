import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { fixture, until } from './runtime-integration-fixtures.mjs';

const serverPath = fileURLToPath(new URL('./runtime-integration-mcp-server.mjs', import.meta.url));
const config = { externalServers: [{ id: 'fixture', transport: 'stdio', command: process.execPath, args: [serverPath] }] };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEAAAAABJRU5ErkJggg==';
const schema = { type: 'object', properties: {
  name: { type: 'string', title: 'Name', minLength: 2 },
  channel: { type: 'string', title: 'Channel', enum: ['internal', 'preview'] },
  confirm: { type: 'boolean', title: 'Confirm' }
}, required: ['name', 'channel', 'confirm'], additionalProperties: false };

test('external official SDK stdio image content survives DevMate service and public MCP response without JSON flattening', async t => {
  const f = await fixture(t, { config }), p = await f.project('image');
  const catalog = await f.tool('capability_list', { projectId: p.project.id, serverId: 'fixture' });
  assert.equal(catalog.isError, undefined, JSON.stringify(catalog));
  assert.ok(catalog.structuredContent.external.tools.some(tool => tool.name === 'image'));
  const response = await f.tool('capability_call', {
    projectId: p.project.id, capability: 'mcp.fixture.tools.call', input: { name: 'image', arguments: {} }
  });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  assert.deepEqual(response.content, [
    { type: 'text', text: 'fixture image caption', annotations: { audience: ['user'] } },
    { type: 'image', data: png, mimeType: 'image/png', annotations: { audience: ['user'], priority: 0.9 } }
  ]);
  assert.deepEqual(response._meta.fixture, { preserve: true });
  assert.equal(response._meta['io.modelcontextprotocol/serverInfo'].name, 'devmate');
  assert.equal(response.structuredContent.source, 'official SDK stdio fixture');
  const pid = response.structuredContent.pid;
  assert.equal(Number.isInteger(pid), true);
  await f.runtime.stop();
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

test('real MCP form elicitation enters the workbench queue, validates original schema and returns exact native response', async t => {
  const f = await fixture(t, { config }), p = await f.project('elicitation');
  const other = await f.project('unrelated');
  const pending = f.tool('capability_call', {
    projectId: p.project.id, capability: 'mcp.fixture.tools.call', input: { name: 'form', arguments: {} }
  });
  // Attach rejection immediately so cleanup cannot create an unhandled promise.
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  const item = await until(async () => {
    const snapshot = await f.call('workbench.snapshot', { ...p.scope });
    return snapshot.inputs.find(input => input.status === 'pending');
  }, 'workbench input queue');
  assert.equal(item.source, 'mcp'); assert.equal(item.serverId, 'fixture'); assert.equal(item.projectId, p.project.id);
  assert.equal(item.details.message, 'Choose a fixture release');
  assert.deepEqual(item.details.requestedSchema, schema);
  // Opening tells the model what was opened; the app reads the data itself.
  const opened = await f.tool('open_devmate_workbench', p.scope);
  assert.deepEqual(Object.keys(opened.structuredContent).sort(), ['counts', 'selection']);
  const scopedUi = await f.tool('workbench_call', { operation: 'workbench.snapshot', input: p.scope });
  assert.equal(scopedUi.structuredContent.inputs[0].id, item.id);
  // The user's answer is given at their computer. A connected client cannot give it, whatever it says it is: the
  // embedded workbench has no such operation, and the generic call refuses it.
  const answer = { id: item.id, response: { action: 'accept', content: { name: 'model-answer', channel: 'internal', confirm: true } } };
  for (const headers of [{}, { 'x-test-app-host': '1' }]) {
    assert.equal((await f.tool('workbench_call', { operation: 'input.respond', input: answer }, headers)).isError, true);
    const generic = await f.tool('operations_call', { operation: 'input.respond', input: answer }, headers);
    assert.equal(generic.isError, true); assert.match(JSON.stringify(generic), /made by the user|user's own/);
  }
  assert.equal((await f.call('input.list', { projectId: p.project.id })).items[0].status, 'pending');
  assert.deepEqual((await f.call('workbench.snapshot', other.scope)).inputs, []);
  const rejected = await f.local('input.respond', { id: item.id, expectedRevision: item.revision, response: { action: 'accept', content: { name: 'x', channel: 'invented', confirm: true } } });
  assert.equal(rejected.body.ok, false); assert.match(rejected.text, /fewer than 2 characters|allowed values/);
  assert.equal((await f.call('input.list', { projectId: p.project.id })).items[0].status, 'pending');
  const response = { action: 'accept', content: { name: 'private-fixture-answer', channel: 'internal', confirm: true } };
  const accepted = await f.call('input.respond', { id: item.id, expectedRevision: item.revision, response });
  assert.equal(accepted.status, 'resolved');
  const final = await outcome;
  assert.equal(final.error, undefined, final.error?.stack);
  assert.equal(final.value.isError, undefined, JSON.stringify(final.value));
  assert.deepEqual(final.value.structuredContent.response, response);
  assert.equal(final.value.content[0].text, 'native form response returned');
  const persisted = JSON.stringify({
    inputs: f.runtime.service.store.list('input'),
    events: f.runtime.service.store.events({ projectId: p.project.id, limit: 10000 })
  });
  assert.equal(persisted.includes('private-fixture-answer'), false, 'answer fields are returned to the native requester but are not journalled');
  const stale = await f.local('input.respond', { id: item.id, response });
  assert.equal(stale.body.ok, false); assert.match(stale.text, /no longer waiting|request_expired/);
});
