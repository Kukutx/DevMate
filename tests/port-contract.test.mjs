import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { __test as cli } from '../scripts/devmate-command.mjs';

const require = createRequire(import.meta.url);
const {
  DEFAULT_PORT,
  MAX_PORT,
  MIN_PORT,
  parsePortOption,
  strictPort
} = require('../shared/port.cjs');
const { choosePort, healthAt, isPortFree } = require('../host/runtime/network.js');
const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));

test('shared port contract accepts only current unprivileged Gateway ports', () => {
  assert.equal(strictPort(DEFAULT_PORT), DEFAULT_PORT);
  assert.equal(strictPort(MIN_PORT), MIN_PORT);
  assert.equal(strictPort(MAX_PORT), MAX_PORT);
  assert.equal(parsePortOption('8787'), 8787);
  assert.equal(parsePortOption(undefined), DEFAULT_PORT);

  for (const value of [0, 1, MIN_PORT - 1, MAX_PORT + 1, -1, 1.5, Number.NaN, '8787', true]) {
    assert.throws(() => strictPort(value), error => error?.code === 'DEVMATE_PORT_INVALID');
  }
  for (const value of ['abc', '8787.5', '-1', '65536', true]) {
    assert.throws(() => parsePortOption(value), error => error?.code === 'DEVMATE_PORT_INVALID');
  }
});

test('VS Code Settings exposes the same strict Gateway port range', () => {
  const setting = manifest.contributes?.configuration?.properties?.['devMate.port'];
  assert.ok(setting);
  assert.equal(setting.default, DEFAULT_PORT);
  assert.equal(setting.minimum, MIN_PORT);
  assert.equal(setting.maximum, MAX_PORT);
});

test('standalone init rejects invalid explicit ports instead of clamping or falling back', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-port-contract-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let index = 0;
  for (const value of ['abc', '8787.5', '1', '65536', -1, 70000, true]) {
    const config = path.join(root, `bad-${index++}`, 'config.json');
    assert.throws(
      () => cli.initConfig({ config, workspace: root, mode: 'personal', provider: 'ngrok', port: value }),
      error => error?.code === 'DEVMATE_PORT_INVALID'
    );
    assert.equal(fs.existsSync(config), false);
  }

  const valid = cli.initConfig({
    config: path.join(root, 'valid', 'config.json'),
    workspace: root,
    mode: 'personal',
    provider: 'ngrok',
    port: String(MIN_PORT)
  });
  assert.equal(valid.config.server.port, MIN_PORT);
});

test('host network layer fails closed before probing invalid ports', async () => {
  assert.throws(() => healthAt(1), error => error?.code === 'DEVMATE_PORT_INVALID');
  assert.throws(() => isPortFree(MAX_PORT + 1), error => error?.code === 'DEVMATE_PORT_INVALID');
  await assert.rejects(
    choosePort({ server: { port: 1 } }, DEFAULT_PORT),
    error => error?.code === 'DEVMATE_PORT_INVALID'
  );
});
