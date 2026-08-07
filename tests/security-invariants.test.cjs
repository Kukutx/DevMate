'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('authentication tokens are accepted only from request headers', async () => {
  const { extractRequestToken } = await import('../gateway/team-access.mjs');
  const queryOnly = {
    headers: {},
    url: '/mcp?token=query-secret'
  };
  assert.equal(extractRequestToken(queryOnly), '');
  assert.equal(
    extractRequestToken({ headers: { authorization: 'Bearer bearer-secret' }, url: '/mcp?token=query-secret' }),
    'bearer-secret'
  );
  assert.equal(
    extractRequestToken({ headers: { 'x-devmate-token': 'header-secret' }, url: '/mcp?token=query-secret' }),
    'header-secret'
  );
});

test('credential rotation does not implicitly reactivate revoked identities', () => {
  for (const relative of ['gateway/team-access.mjs', 'gateway/runner-access.mjs']) {
    const source = read(relative);
    const rotateStart = source.search(/export function rotate(?:TeamMemberToken|RunnerCredentialToken)/);
    assert.ok(rotateStart >= 0, relative);
    const nextExport = source.indexOf('\nexport function ', rotateStart + 20);
    const body = source.slice(rotateStart, nextExport < 0 ? source.length : nextExport);
    assert.doesNotMatch(body, /disabled\s*=\s*false/, relative);
  }
});

test('workspace resolution is ID-first and rejects ambiguous names', async () => {
  const { resolveWorkspace } = await import('../gateway/workspace-resolver.mjs');
  const config = {
    activeWorkspaceId: 'primary',
    workspaces: [
      { id: 'primary', name: 'shared', root: '/one' },
      { id: 'secondary', name: 'shared', root: '/two' },
      { id: 'shared', name: 'different', root: '/three' }
    ]
  };
  assert.equal(resolveWorkspace(config, 'shared').id, 'shared');
  assert.throws(
    () => resolveWorkspace({ ...config, workspaces: config.workspaces.slice(0, 2) }, 'shared'),
    error => error?.code === 'workspace_ambiguous'
  );
});

test('Runner API matching is version-boundary safe', () => {
  const source = read('gateway/runner-control-plane.mjs');
  assert.match(source, /url\.pathname !== PREFIX && !url\.pathname\.startsWith\(`\$\{PREFIX\}\//);
  assert.doesNotMatch(source, /if \(!url\?\.pathname\.startsWith\(PREFIX\)\)/);
});

test('production Host policy fails closed when no allowlist exists', async () => {
  const { hostAllowed } = await import('../gateway/http-host-policy.mjs');
  const config = { deployment: { mode: 'production' }, production: { allowedHosts: [] } };
  assert.equal(hostAllowed({ headers: { host: 'devmate.example.com' }, socket: { remoteAddress: '203.0.113.10' } }, config), false);
  assert.equal(hostAllowed({ headers: { host: '127.0.0.1:8787' }, socket: { remoteAddress: '127.0.0.1' } }, config), true);
  assert.equal(hostAllowed({ headers: { host: 'localhost:8787' }, socket: { remoteAddress: '203.0.113.10' } }, config), false);
});

test('explicit invalid config and durable-state versions are rejected', () => {
  assert.match(read('shared/config-store.cjs'), /invalid_config_version/);
  assert.match(read('gateway/durable-state.mjs'), /invalid_state_version/);
});
