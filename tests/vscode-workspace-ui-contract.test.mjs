import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('VS Code exposes workspace management without replacing the shared-tunnel extension entry', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.main, './extension-entry-shared-tunnel.js');
  const commands = new Map((pkg.contributes?.commands || []).map(command => [command.command, command.title]));
  assert.equal(commands.get('devMate.manageWorkspaces'), 'DevMate: Manage Workspaces');
  assert.equal(commands.get('devMate.addWorkspace'), 'DevMate: Add Workspace');
  assert.ok(pkg.activationEvents.includes('onCommand:devMate.manageWorkspaces'));
  assert.ok(pkg.activationEvents.includes('onCommand:devMate.addWorkspace'));

  const entry = read('extension-entry-platform.js');
  assert.match(entry, /activateWorkspaceManagement/);
  assert.match(entry, /deactivateWorkspaceManagement/);
  assert.match(entry, /await activateWorkspaceManagement\(context\)/);
  assert.match(entry, /await deactivateWorkspaceManagement\(\)/);
});

test('workspace manager uses the product contract terminology and exposes multiple writable workspace controls', () => {
  const source = read('extension-entry-workspaces.js');
  assert.match(source, /Current Project/);
  assert.match(source, /Additional Workspaces/);
  assert.match(source, /different conversations can use different workspaces at the same time/);
  assert.match(source, /fullAccess/);
  assert.match(source, /Add Workspace/);
  assert.match(source, /Open in New Window/);
  assert.match(source, /Copy ID/);
  assert.match(source, /Remove/);
  assert.match(source, /crypto\.randomBytes\(16\)\.toString\('base64'\)/);
  assert.doesNotMatch(source, /Math\.random\(\)/);
  assert.match(source, /executeCommand\('devMate\.start', \{ quiet: true, activateWorkspace: false \}\)/);
});

test('main DevMate panel exposes Current Project and the workspace manager entry point', () => {
  const source = read('extension.js');
  assert.match(source, /Current Project/);
  assert.match(source, /This VS Code/);
  assert.match(source, /Manage Workspaces/);
  assert.match(source, /data-cmd="manageWorkspaces"/);
  assert.match(source, /devMate\.manageWorkspaces/);
});

test('routing documentation preserves singular Current Project and sticky conversation semantics', () => {
  const routing = read('docs/CHATGPT_WORKSPACE_ROUTING.md');
  assert.match(routing, /one shared Current Project/i);
  assert.match(routing, /later host workspace change silently moves an already-used conversation/i);
  assert.match(routing, /automatic host startup\/recovery does not replace `activeWorkspaceId` by default/i);
  assert.match(routing, /explicit binding survives host switches and reconnect-style reuse/i);
  assert.match(routing, /conversation/i);
});
