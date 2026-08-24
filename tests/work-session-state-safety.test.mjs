import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-work-session-state-'));
process.env.DEVMATE_CONFIG = path.join(temp, 'config.json');
await fsp.writeFile(process.env.DEVMATE_CONFIG, JSON.stringify({ version: 11 }), 'utf8');

const durable = await import('../gateway/durable-state.mjs');
const sessions = await import('../gateway/work-sessions.mjs');

test('malformed work session state fails closed without dropping rollback/audit evidence', () => {
  const malformed = [{
    id: 'work-corrupt',
    principalId: 'alice',
    principalName: 'Alice',
    principalRole: 'developer',
    workspaceId: 'app',
    title: 'Corrupt',
    purpose: 'test',
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    leaseId: '',
    toolCalls: 2,
    failures: 0
  }];
  durable.writeDurableNamespace('work-sessions', malformed);
  durable.resetDurableStateForTests();
  assert.throws(
    () => sessions.syncWorkSessionsFromDurableState(),
    error => error?.code === 'work_session_state_invalid' && /leaseId/.test(error.message)
  );
  durable.resetDurableStateForTests();
  assert.deepEqual(durable.readDurableNamespace('work-sessions', null), malformed);
});

test.after(async () => {
  delete process.env.DEVMATE_CONFIG;
  await fsp.rm(temp, { recursive: true, force: true });
});