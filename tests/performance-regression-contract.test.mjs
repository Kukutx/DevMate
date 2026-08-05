import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('health probing remains bounded and uses short candidate-port timeouts', () => {
  const network = read('host/runtime/network.js');
  assert.match(network, /MAX_HTTP_RESPONSE_BYTES/);
  assert.match(network, /response\.destroy/);
  assert.match(network, /healthAt\(port, 600\)/);
});

test('startup convergence avoids duplicate host process creation', () => {
  const controller = read('host/runtime/process-controller.js');
  assert.match(controller, /waitForStartupLease/);
  assert.match(controller, /Attached to DevMate Gateway started by another host/);
  assert.match(controller, /converged:\s*true/);
});

test('context and host lifecycle work is coalesced instead of parallelized', () => {
  const obsidian = read('obsidian-plugin/src/main.js');
  const vscode = read('extension.js');
  assert.match(obsidian, /hostOperations\.run\('capture'/);
  assert.match(obsidian, /clearTimeout\(this\.contextTimer\)/);
  assert.match(vscode, /lifecycleOperations\.run/);
  assert.match(vscode, /clearTimeout\(contextWriteTimer\)/);
});
