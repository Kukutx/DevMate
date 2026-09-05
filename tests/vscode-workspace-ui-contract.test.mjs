import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('VS Code exposes workspace management without replacing the shared-tunnel extension entry', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.main, './extension-entry-shared-tunnel.js');
  const commands = new Map((pkg.contributes?.commands || []).map(item => [item.command, item.title]));
  assert.equal(commands.get('devMate.manageWorkspaces'), 'DevMate: Manage Workspaces');
  assert.equal(commands.get('devMate.addWorkspace'), 'DevMate: Add Workspace');
  assert.ok(pkg.activationEvents.includes('onCommand:devMate.manageWorkspaces'));
  assert.ok(pkg.activationEvents.includes('onCommand:devMate.addWorkspace'));

  const platform = read('extension-entry-platform.js');
  assert.match(platform, /require\('\.\/extension-entry-workspaces\.js'\)/);
  assert.match(platform, /await activateWorkspaceManagement\(context\)/);
  assert.match(platform, /await deactivateWorkspaceManagement\(\)/);

  const manager = read('extension-entry-workspaces.js');
  assert.doesNotMatch(manager, /require\('\.\/extension-entry-shared-tunnel\.js'\)/);
});

test('workspace manager uses the product contract terminology and exposes multiple writable workspace controls', () => {
  const source = read('extension-entry-workspaces.js');
  assert.match(source, />Current Project</);
  assert.match(source, />Additional Workspaces</);
  assert.match(source, /default for ChatGPT conversations until a conversation explicitly selects another workspace/);
  assert.match(source, /different conversations can use different workspaces at the same time/);
  assert.match(source, /Add Workspace/);
  assert.match(source, /Browse/);
  assert.match(source, /From Clipboard/);
  assert.match(source, /Copy ID/);
  assert.match(source, /Open in New Window/);
  assert.match(source, /explicit selection, a conversation follows the current VS Code\/Obsidian project/);
});

test('main DevMate panel exposes Current Project and the workspace manager entry point', () => {
  const source = read('extension.js');
  assert.match(source, /<b>Current Project<\/b>/);
  assert.doesNotMatch(source, /<b>Active project<\/b>/);
  assert.match(source, /data-cmd="manageWorkspaces">Manage Workspaces<\/button>/);
  assert.match(source, /if\(m\.cmd==='manageWorkspaces'\) await vscode\.commands\.executeCommand\('devMate\.manageWorkspaces'\)/);
  assert.match(source, /Additional writable workspaces can be managed separately and selected per ChatGPT conversation/);
});

test('routing documentation forbids both fail-closed rollback and global multi-active semantics', () => {
  const contract = read('docs/CHATGPT_WORKSPACE_ROUTING.md');
  assert.match(contract, /Current Project/);
  assert.match(contract, /Additional Workspaces/);
  assert.match(contract, /does \*\*not\*\* mean mutating a single global `activeWorkspaceId` into an array/);
  assert.match(contract, /adding another writable workspace changes the Current Project/);
  assert.match(contract, /all writable roots become implicit defaults/);
  assert.match(contract, /every new ChatGPT conversation must bind before doing project work/);
});
