import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __test } from '../scripts/devmate-cli.mjs';

test('creates a secure standalone team config, owner URL, and team member', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-cli-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'state', 'config.json');
  const result = __test.initConfig({
    config,
    workspace: root,
    mode: 'team',
    provider: 'external',
    'public-url': 'devmate.example.com'
  });
  assert.equal(result.config.deployment.mode, 'team');
  assert.equal(result.config.deployment.publicUrl, 'https://devmate.example.com');
  assert.match(__test.ownerUrl({ config }), /^https:\/\/devmate\.example\.com\/mcp\?token=/);
  const created = __test.memberCreate({
    config,
    name: 'Alice',
    role: 'developer',
    workspaces: 'workspace'
  });
  assert.match(created.token, /^dmt_/);
  assert.equal(__test.memberList({ config })[0].name, 'Alice');
  const stat = await fsp.stat(config);
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
});

test('rejects development-only quick tunnels and insecure public URLs for production', () => {
  assert.throws(
    () => __test.cleanProvider('cloudflare-quick', 'production'),
    /development-only/
  );
  assert.throws(
    () => __test.normalizeOrigin('http://devmate.example.com', { httpsOnly: true }),
    /HTTPS/
  );
});
