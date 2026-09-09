import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import permissionConfig from '../shared/permission-config.cjs';
import {
  installFileMutationSafety,
  safeFileMutationHandler,
  __test as safety
} from '../gateway/file-mutation-safety.mjs';
import { serverExtensionHostStatus } from '../gateway/server-extension-host.mjs';

class FakeServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, config, handler) {
    this.tools.set(name, { config, handler });
    return { name };
  }
  async connect() { return true; }
}

test('all six core filesystem mutation tools are replaced by crash-safe handlers before authorization', () => {
  installFileMutationSafety(FakeServer);
  const status = serverExtensionHostStatus(FakeServer);
  assert(status.decorators.some(item => item.id === 'devmate.file-mutation-safety' && item.order === 5));
  const server = new FakeServer();
  for (const name of safety.SAFE_FILE_TOOLS) {
    const unsafe = async () => ({ unsafe: true });
    server.registerTool(name, { annotations: { destructiveHint: true } }, unsafe);
    const registered = server.tools.get(name);
    assert.notEqual(registered.handler, unsafe, `${name} must not retain the direct server.mjs mutation handler`);
    assert.equal(registered.handler, safeFileMutationHandler(name));
  }
});

test('read-only and unrelated tools are not intercepted by filesystem transaction safety', () => {
  installFileMutationSafety(FakeServer);
  const server = new FakeServer();
  const handler = async () => ({ ok: true });
  server.registerTool('read_file', {}, handler);
  assert.equal(server.tools.get('read_file').handler, handler);
});

test('mutation policy treats direct secrets, hidden paths and non-text writes as unsafe', () => {
  assert.equal(safety.isBinaryOrSecret('.git/config'), true);
  assert.equal(safety.isBinaryOrSecret('.env'), true);
  assert.equal(safety.isBinaryOrSecret('src/app.js'), false);
  assert.equal(safety.isTextAllowed('src/app.js'), true);
  assert.equal(safety.isTextAllowed('image.png'), false);
});

test('canonical fullAccess reaches the directory mutation gate without a secondary opt-in', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-full-access-directory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'safe-directory');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'file.txt'), 'safe', 'utf8');

  const config = {
    permissions: permissionConfig.permissionPolicySnapshot({
      permissions: {
        profile: 'fullAccess',
        readOnly: false,
        blockDangerousOperations: true,
        confirmBeforePush: true,
        allowDirectoryMutations: false
      }
    })
  };
  const workspace = { id: 'app', name: 'App', root, mode: 'workspace-write', reference: false };

  const stat = await safety.assertDirectoryMutationAllowed(config, workspace, directory, 'safe-directory');
  assert.equal(stat.isDirectory(), true);
  assert.equal(config.permissions.allowDirectoryMutations, true);
});

test('balanced still requires its explicit directory-mutation preference', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-balanced-directory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'safe-directory');
  fs.mkdirSync(directory);

  const config = {
    permissions: permissionConfig.permissionPolicySnapshot({
      permissions: {
        profile: 'balanced',
        readOnly: false,
        blockDangerousOperations: true,
        confirmBeforePush: false,
        allowDirectoryMutations: false
      }
    })
  };
  const workspace = { id: 'app', name: 'App', root, mode: 'workspace-write', reference: false };

  await assert.rejects(
    safety.assertDirectoryMutationAllowed(config, workspace, directory, 'safe-directory'),
    /Directory mutation blocked/
  );
});
