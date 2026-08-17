import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';
import packageJson from '../package.json' with { type: 'json' };
import { __test as cli } from '../scripts/devmate-command.mjs';

test('standalone CLI uses the shared configuration store without a compatibility subprocess', () => {
  for (const relative of ['scripts/standalone-runtime.mjs', 'scripts/devmate-command.mjs']) {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', relative), 'utf8');
    assert.match(source, /shared\/config-store\.cjs/);
    assert.equal(source.includes('fs.writeFileSync'), false);
  }
  const command = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scripts/devmate-command.mjs'), 'utf8');
  assert.equal(command.includes('devmate-cli.mjs'), false);
  assert.equal(command.includes('spawn('), false);
});

test('standalone initialization writes the supported default no-auth schema atomically', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-cli-store-'));
  const workspace = path.join(directory, 'workspace');
  const config = path.join(directory, 'state', 'config.json');
  fs.mkdirSync(workspace);
  const result = cli.initConfig({ workspace, config, provider: 'ngrok' });
  const persisted = configStore.readJson(config, null, { strict: true, supportedVersion: true });
  assert.equal(result.file, config);
  assert.equal(persisted.version, configStore.SUPPORTED_CONFIG_VERSION);
  assert.equal(persisted.appVersion, packageJson.version);
  assert.deepEqual(persisted.auth, { mode: 'none' });
  assert.equal(persisted.connection.provider, 'ngrok');
  assert.equal(fs.existsSync(path.join(directory, 'state', 'state', 'oauth-secrets.json')), false);
  assert.equal('deployment' in persisted, false);
  assert.equal('production' in persisted, false);
});

test('standalone initialization with a public URL keeps no-auth by default and accepts explicit no-auth', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-cli-public-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);

  const config = path.join(directory, 'default', 'config.json');
  cli.initConfig({
    workspace,
    config,
    provider: 'external',
    'public-url': 'https://devmate.example.com'
  });
  const persisted = configStore.readJson(config, null, { strict: true, supportedVersion: true });
  assert.deepEqual(persisted.auth, { mode: 'none' });
  assert.equal(persisted.connection.publicUrl, 'https://devmate.example.com');
  assert.equal(fs.existsSync(path.join(directory, 'default', 'state', 'oauth-secrets.json')), false);

  const explicit = path.join(directory, 'explicit-none', 'config.json');
  cli.initConfig({
    workspace,
    config: explicit,
    provider: 'external',
    'public-url': 'https://devmate.example.com',
    'authentication-mode': 'none'
  });
  assert.deepEqual(configStore.readJson(explicit, null, { strict: true, supportedVersion: true }).auth, { mode: 'none' });
});

test('standalone public OAuth remains available only when explicitly selected', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-cli-oauth-'));
  const workspace = path.join(directory, 'workspace');
  const config = path.join(directory, 'oauth', 'config.json');
  fs.mkdirSync(workspace);
  cli.initConfig({
    workspace,
    config,
    provider: 'external',
    'public-url': 'https://devmate.example.com',
    'authentication-mode': 'oauth'
  });
  const persisted = configStore.readJson(config, null, { strict: true, supportedVersion: true });
  assert.deepEqual(persisted.auth, { mode: 'oauth' });
  assert.equal(fs.existsSync(path.join(directory, 'oauth', 'state', 'oauth-secrets.json')), true);
});

test('member creation preserves no-auth and does not initialize OAuth state implicitly', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-cli-member-'));
  const workspace = path.join(directory, 'workspace');
  const config = path.join(directory, 'state', 'config.json');
  fs.mkdirSync(workspace);
  cli.initConfig({ workspace, config, provider: 'ngrok' });
  const created = cli.memberCreate({ config, name: 'Alice', role: 'developer', workspaces: 'workspace' });
  assert.match(created.loginCode, /^dmc_/);
  const persisted = configStore.readJson(config, null, { strict: true, supportedVersion: true });
  assert.deepEqual(persisted.auth, { mode: 'none' });
  assert.equal(persisted.team.members.length, 1);
  assert.equal(persisted.team.members[0].authVersion, 1);
  assert.equal(JSON.stringify(persisted).includes(created.loginCode), false);
  assert.equal(fs.existsSync(path.join(directory, 'state', 'state', 'oauth-secrets.json')), false);
});
