import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('Gateway startup never waits for retention maintenance', () => {
  const serverSource = fs.readFileSync(path.join(root, 'gateway', 'server.mjs'), 'utf8');
  const runtimeSource = fs.readFileSync(path.join(root, 'gateway', 'server-runtime.mjs'), 'utf8');

  assert.equal(serverSource.includes('pruneState'), false, 'server.mjs must not perform retention maintenance on the Ready path');

  const readyIndex = runtimeSource.indexOf("completeStartupProgress('server_module_loaded');");
  const scheduleIndex = runtimeSource.indexOf('setImmediate(() => {', readyIndex);
  const maintenanceIndex = runtimeSource.indexOf('runRuntimeMaintenanceOnce({ force: true })', readyIndex);
  assert.ok(readyIndex >= 0, 'startup completion marker is missing');
  assert.ok(scheduleIndex > readyIndex, 'initial maintenance must be scheduled only after startup completion');
  assert.ok(maintenanceIndex > scheduleIndex, 'initial maintenance must run inside the post-Ready schedule');
});
