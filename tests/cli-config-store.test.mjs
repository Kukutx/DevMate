import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';
import packageJson from '../package.json' with { type: 'json' };
import { __test as cli } from '../scripts/devmate-cli.mjs';

test('standalone CLIs use only the shared configuration store', () => {
  for (const relative of ['scripts/devmate-cli.mjs', 'scripts/devmate-command.mjs']) {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', relative), 'utf8');
    assert.match(source, /shared\/config-store\.cjs/);
    assert.equal(source.includes('fs.writeFileSync'), false);
    assert.equal(source.includes('function writeSecureJson'), false);
  }
});

test('standalone initialization writes the supported package version atomically', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-cli-store-'));
  const workspace = path.join(directory, 'workspace');
  const config = path.join(directory, 'state', 'config.json');
  fs.mkdirSync(workspace);
  const result = cli.initConfig({ workspace, config, mode: 'personal', provider: 'external' });
  const persisted = configStore.readJson(config, null, { strict: true, supportedVersion: true });
  assert.equal(result.file, config);
  assert.equal(persisted.version, configStore.SUPPORTED_CONFIG_VERSION);
  assert.equal(persisted.appVersion, packageJson.version);
  assert.equal(persisted.auth.token, result.token);
});
