import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('VS Code exposes the workspace manager as part of the normal extension entry chain', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.main, './extension-entry-workspaces.js');
  const commands = new Map((pkg.contributes?.commands || []).map(item => [item.command, item.title]));
  assert.equal(commands.get('devMate.manageWorkspaces'), 'DevMate: Manage Workspaces');
  assert.equal(commands.get('devMate.addWorkspace'), 'DevMate: Add Workspace');
  assert.ok(pkg.activationEvents.includes('onCommand:devMate.manageWorkspaces'));
  assert.ok(pkg.activationEvents.includes('onCommand:devMate.addWorkspace'));
});

test('workspace manager uses the product contract terminology and keeps the shared-tunnel runtime underneath', () => {
  const source = read('extension-entry-workspaces.js');
  assert.match(source, /require\('\.\/extension-entry-shared-tunnel\.js'\)/);
  assert.match(source, />Current Project</);
  assert.match(source, />Additional Workspaces</);
  assert.match(source, /default for ChatGPT conversations until a conversation explicitly selects another workspace/);
  assert.match(source, /different conversations can use different workspaces at the same time/);
  assert.match(source, /explicit conversation pin never changes/i);
});

test('routing documentation forbids both fail-closed rollback and global multi-active semantics', () => {
  const contract = read('docs/CHATGPT_WORKSPACE_ROUTING.md');
  assert.match(contract, /Current Project/);
  assert.match(contract, /Additional Workspaces/);
  assert.match(contract, /does \*\*not\*\* mean mutating a single global `activeWorkspaceId` into an array/);
  assert.match(contract, /adding another writable workspace changes the Current Project/);
  assert.match(contract, /all writable roots become implicit defaults/);
});
