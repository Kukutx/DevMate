import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-oauth-state-'));
const configPath = path.join(directory, 'config.json');
const config = configStore.newInstanceConfig({
  workspaceRoot: process.cwd(),
  port: 8787,
  appVersion: configStore.DEFAULT_VERSION
});
configStore.atomicWriteJson(configPath, config);
process.env.DEVMATE_CONFIG = configPath;

const state = await import('../gateway/oauth-state.mjs');

test('OAuth authorization codes are single-use', () => {
  const nonce = `nonce-${Date.now()}`;
  state.registerAuthorizationCode(nonce, new Date(Date.now() + 60_000).toISOString());
  assert.equal(state.consumeAuthorizationCode(nonce), true);
  assert.equal(state.consumeAuthorizationCode(nonce), false);
});

test('refresh-token rotation is single-use and replay persistently revokes the whole family', () => {
  const binding = {
    subject: 'member:alice',
    authVersion: 7,
    clientId: 'https://client.example/oauth/client-metadata.json',
    audience: 'https://devmate.example/mcp',
    scope: 'devmate offline_access'
  };
  const family = state.createRefreshFamily(binding);
  assert.equal(family.generation, 1);
  const rotated = state.consumeRefreshFamily({ ...binding, familyId: family.id, generation: 1 });
  assert.equal(rotated.generation, 2);

  assert.throws(
    () => state.consumeRefreshFamily({ ...binding, familyId: family.id, generation: 1 }),
    error => error?.code === 'oauth_refresh_reuse'
  );
  assert.throws(
    () => state.consumeRefreshFamily({ ...binding, familyId: family.id, generation: 2 }),
    error => error?.code === 'oauth_refresh_invalid'
  );
  const status = state.oauthRuntimeStateStatus();
  assert.equal(status.activeRefreshFamilies, 0);
  assert.equal(status.revokedRefreshFamilies, 1);
});

test('binding mismatch revokes the refresh family instead of leaving it reusable', () => {
  const binding = {
    subject: 'member:bob',
    authVersion: 2,
    clientId: 'https://client.example/oauth/client-metadata.json',
    audience: 'https://devmate.example/mcp',
    scope: 'devmate offline_access'
  };
  const family = state.createRefreshFamily(binding);
  assert.throws(
    () => state.consumeRefreshFamily({ ...binding, clientId: 'https://other.example/client.json', familyId: family.id, generation: 1 }),
    error => error?.code === 'oauth_refresh_invalid'
  );
  assert.throws(
    () => state.consumeRefreshFamily({ ...binding, familyId: family.id, generation: 1 }),
    error => error?.code === 'oauth_refresh_invalid'
  );
});

test.after(() => {
  delete process.env.DEVMATE_CONFIG;
  fs.rmSync(directory, { recursive: true, force: true });
});
