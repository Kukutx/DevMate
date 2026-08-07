import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __test } from '../scripts/devmate-command.mjs';

test('creates a secure standalone team config, owner URL, and team member', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-cli-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'state', 'config.json');
  const result = __test.initConfig({ config, workspace: root, mode: 'team', provider: 'external', 'public-url': 'devmate.example.com' });
  assert.equal(result.config.deployment.mode, 'team');
  assert.equal(result.config.deployment.publicUrl, 'https://devmate.example.com');
  assert.equal(__test.ownerUrl({ config }), 'https://devmate.example.com/mcp');
  assert.match(result.token, /^[A-Za-z0-9_-]{40,}$/);
  const created = __test.memberCreate({ config, name: 'Alice', role: 'developer', workspaces: 'workspace' });
  assert.match(created.token, /^dmt_/);
  assert.equal(__test.memberList({ config })[0].name, 'Alice');
  const stat = await fsp.stat(config);
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
});

test('rejects invalid deployment inputs instead of silently falling back', () => {
  assert.throws(() => __test.cleanMode('old-mode'), /Unknown deployment mode/);
  assert.throws(() => __test.cleanProvider('cloudflare-quick', 'production'), /development-only/);
  assert.throws(() => __test.cleanProvider('old-provider', 'team'), /Unknown tunnel provider/);
  assert.throws(() => __test.normalizeOrigin('http://devmate.example.com', { httpsOnly: true }), /HTTPS/);
});
