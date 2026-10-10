import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DevMateService } from '../runtime/service.mjs';

// The owner at this computer, and the same owner reached through MCP: a connected model, or a workbench embedded in a chat app.
const local = Object.freeze({ id: 'owner', role: 'owner', surface: 'local' });
const connected = Object.freeze({ id: 'owner', role: 'owner', projectIds: null });

async function fixture(t) {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-decisions-')));
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '' });
  await service.ready;
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const folder = (...names) => { const root = path.join(temp, ...names); fs.mkdirSync(root, { recursive: true }); return root; };
  return { service, temp, folder };
}

test('what the owner decided on their computer cannot be undone by a connected client: read only, protected credentials, what is shared', async t => {
  const { service, folder } = await fixture(t);
  const app = folder('workspace', 'app');
  fs.writeFileSync(path.join(app, '.env'), 'TOKEN=protected-value\n');
  const project = await service.call('project.create', { root: app, access: 'read' }, local);
  // Narrowing and renaming are always allowed; widening and lifting the protection are not.
  await assert.rejects(service.call('project.update', { id: project.id, access: 'write' }, connected), { code: 'forbidden', message: /read only/ });
  await assert.rejects(service.call('project.update', { id: project.id, protectSecrets: false }, connected), { code: 'forbidden', message: /own computer/ });
  assert.equal((await service.call('project.update', { id: project.id, name: 'renamed' }, connected)).name, 'renamed');
  await assert.rejects(service.call('workspace.read', { projectId: project.id, path: '.env' }, connected), { code: 'protected_workspace_path' });
  await assert.rejects(service.call('workspace.write', { projectId: project.id, path: 'x.txt', text: 'x' }, connected), { code: 'read_only' });
  // Sharing a folder at all is the owner's act: in a writable project a client runs commands, and with those it reaches
  // everything the owner can. Above, inside or beside what is shared makes no difference.
  for (const root of [path.dirname(app), folder('workspace', 'app', 'src'), folder('elsewhere')])
    await assert.rejects(service.call('project.create', { root }, connected), { code: 'forbidden', message: /shared by the owner on their own computer/ });
  // The refusal comes before any look at the disk: a path a client names never makes DevMate open a network share.
  await assert.rejects(service.call('project.create', { root: '\\\\devmate-test.invalid\\share\\folder' }, connected), { code: 'forbidden' });
  await assert.rejects(service.call('workspace.read', { projectId: '\\\\devmate-test.invalid\\share\\folder', path: 'a.txt' }, connected), error => ['project_not_registered', 'not_found'].includes(error.code));
  // What a client says about itself changes nothing: an embedded workbench is a connected client too.
  await assert.rejects(service.call('project.update', { id: project.id, access: 'write' }, { ...connected, humanInterface: true }), { code: 'forbidden' });
  // It is not offered what it cannot do.
  const offered = context => service.visibleOperations(context).map(operation => operation.name);
  for (const name of ['project.create', 'approval.resolve', 'input.respond']) { assert.equal(offered(connected).includes(name), false, name); assert.equal(offered(local).includes(name), true, name); }
  // An engine's settings name programs on this computer: a client can switch an engine off and nothing more.
  await assert.rejects(service.call('capability.configure', { engine: 'godot', settings: { enabled: true } }, connected), { code: 'forbidden' });
  await assert.rejects(service.call('capability.configure', { engine: 'godot', settings: { enabled: false, executable: 'C:/anything.exe' } }, connected), { code: 'forbidden' });
  await service.call('capability.configure', { engine: 'godot', settings: { enabled: false } }, connected);
  assert.equal((await service.call('project.update', { id: project.id, access: 'read' }, connected)).access, 'read', 'a client may narrow');
  // The owner does all of it at their computer.
  assert.equal((await service.call('project.update', { id: project.id, access: 'write', protectSecrets: false }, local)).protectSecrets, false);
  assert.equal((await service.call('workspace.read', { projectId: project.id, path: '.env' }, connected)).text, 'TOKEN=protected-value\n');
  // The owner's own nesting stays possible: a monorepo and one of its packages in two editor windows.
  assert.equal((await service.call('project.create', { root: folder('workspace', 'app', 'packages', 'api') }, local)).name, 'api');
});

test('a folder taken out of sharing stays out until the owner shares it again, whoever asks and whichever window opens it', async t => {
  const { service, folder } = await fixture(t);
  const root = folder('area', 'taken-out'), other = folder('kept');
  const first = await service.call('project.create', { root }, local);
  await service.call('project.create', { root: other }, local);
  await service.call('project.remove', { id: first.id }, connected);
  assert.equal(service.isDeclined(root), true);
  await assert.rejects(service.call('project.create', { root }, connected), { code: 'forbidden' });
  // An editor window that has the folder open applies its default to every folder: this one is left alone.
  const windowId = '0d5f7c1e-6a51-4d0e-9f77-2b0c8a6d1e10';
  const attached = await service.call('window.attach', { windowId, roots: [{ root, name: 'taken-out', register: 'write' }, { root: other, name: 'kept', register: 'write' }] }, local);
  assert.deepEqual(attached.roots.map(item => [item.name, !!item.projectId, item.declined === true]), [['taken-out', false, true], ['kept', true, false]]);
  assert.equal((await service.call('project.list', {}, local)).items.length, 1);
  // Nor does an editor's default bring it back through the folder above it or a folder inside it.
  const around = await service.call('window.attach', { windowId: '7c1e0d5f-51a6-4e0d-b779-6d1e102b0c8a',
    roots: [{ root: path.dirname(root), name: 'area', register: 'write' }, { root: folder('area', 'taken-out', 'inner'), name: 'inner', register: 'write' }] }, local);
  assert.deepEqual(around.roots.map(item => !!item.projectId), [false, false]);
  // The heartbeat tells the window what is shared now, so it does not go on showing what it saw at attach.
  const kept = attached.roots[1].projectId;
  await service.call('project.update', { id: kept, access: 'read' }, local);
  const beat = await service.call('window.heartbeat', { windowId }, local);
  assert.equal(beat.attached, true); assert.equal(beat.roots.find(item => item.projectId === kept).access, 'read');
  // What the editor has open but does not share is shown to the owner here, and to nobody through MCP: not in the
  // list of windows and not in the state the workbench loads.
  const named = items => items.find(item => item.windowId === windowId).roots.map(item => item.name);
  assert.equal((await service.call('window.list', {}, local)).items.find(item => item.windowId === windowId).roots.length, 2);
  assert.deepEqual(named((await service.call('window.list', {}, connected)).items), ['kept']);
  assert.deepEqual(named((await service.call('workbench.snapshot', {}, connected)).windows), ['kept']);
  assert.equal(named((await service.call('workbench.snapshot', {}, local)).windows).length, 2);
  // The owner's own choice at that window shares it again, and from then on it is an ordinary project.
  const again = await service.call('window.attach', { windowId, roots: [{ root, name: 'taken-out', register: 'read', chosen: true }] }, local);
  assert.equal(again.roots[0].access, 'read'); assert.equal(service.isDeclined(root), false);
  // So does registering it from the command line.
  await service.call('project.remove', { id: again.roots[0].projectId }, local);
  assert.equal((await service.call('project.create', { root }, local)).access, 'write');
});

test('one folder that is gone or cannot be a project does not cost an editor window its other folders', async t => {
  const { service, folder, temp } = await fixture(t);
  const good = folder('good'), gone = path.join(temp, 'deleted-meanwhile');
  const windowId = '5b0a7e3c-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  // The instance directory lies inside this folder, so it can never be a project; the default says why and moves on.
  const attached = await service.call('window.attach', { windowId, selectedRoot: gone,
    roots: [{ root: gone, name: 'deleted-meanwhile', register: 'write' }, { root: temp, name: 'contains-devmate', register: 'write' }, { root: good, name: 'good', register: 'write' }] }, local);
  const byName = Object.fromEntries(attached.roots.map(item => [item.name, item]));
  assert.ok(byName.good.projectId); assert.equal(attached.selectedProjectId, byName.good.projectId);
  assert.equal(byName['deleted-meanwhile'].projectId, null); assert.match(byName['deleted-meanwhile'].reason, /cannot be opened/);
  assert.equal(byName['contains-devmate'].projectId, null); assert.match(byName['contains-devmate'].reason, /separate from the DevMate control directory/);
  // The owner asking for exactly that folder is told plainly instead.
  await assert.rejects(service.call('window.attach', { windowId, roots: [{ root: temp, name: 'contains-devmate', register: 'write', chosen: true }] }, local), { code: 'private_runtime' });
});

test('a read-only project takes no new DevMate records, and an artifact is read with the same checks as any file', async t => {
  const { service, folder } = await fixture(t);
  const root = folder('records');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=protected-value\n'); fs.writeFileSync(path.join(root, 'report.txt'), 'findings\n');
  const project = await service.call('project.create', { root }, local);
  const workflow = await service.call('workflow.create', { projectId: project.id, title: 'Flow' }, local);
  const artifact = await service.call('artifact.create', { projectId: project.id, workflowId: workflow.id, path: 'report.txt', mimeType: 'text/plain' }, local);
  assert.equal((await service.call('artifact.read', { id: artifact.id }, local)).text, 'findings\n');
  // A second name for the protected file is not a way around its protection.
  let linked = true;
  try { fs.linkSync(path.join(root, '.env'), path.join(root, 'alias.txt')); } catch { linked = false; }
  if (linked) {
    await assert.rejects(service.call('artifact.create', { projectId: project.id, workflowId: workflow.id, path: 'alias.txt' }, local), { code: 'unsafe_file' });
    // Nor is turning an already registered artifact into one.
    fs.rmSync(path.join(root, 'report.txt')); fs.linkSync(path.join(root, '.env'), path.join(root, 'report.txt'));
    await assert.rejects(service.call('artifact.read', { id: artifact.id }, local), { code: 'unsafe_file' });
  }
  await assert.rejects(service.call('artifact.create', { projectId: project.id, workflowId: workflow.id, path: '.env' }, local), { code: 'protected_workspace_path' });
  await service.call('project.update', { id: project.id, access: 'read' }, local);
  const writer = { id: 'member', role: 'write', projectIds: [project.id] };
  for (const [operation, input] of [['workflow.create', { title: 'Another' }], ['task.create', { workflowId: workflow.id, title: 'T', instruction: 'do' }],
    ['reference.add', { workflowId: workflow.id, uri: 'https://example.com', name: 'ref' }], ['artifact.create', { workflowId: workflow.id, path: 'report.txt' }]]) {
    await assert.rejects(service.call(operation, { projectId: project.id, ...input }, writer), { code: 'read_only' }, operation);
  }
  assert.equal((await service.call('workflow.list', { projectId: project.id }, writer)).items.length, 1, 'what exists stays readable');
});
