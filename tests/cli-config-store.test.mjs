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

test('standalone initialization writes the supported capability schema atomically', () => {
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
  assert.equal('deployment' in persisted, false);
  assert.equal('production' in persisted, false);
});
