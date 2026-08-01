import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(path.resolve('gateway/local-shared.mjs')).href;

test('writes DevMate config atomically with valid JSON and no temporary files', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-config-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  await fsp.writeFile(configPath, '{"version":1}\n', 'utf8');
  const previous = process.env.DEVMATE_CONFIG;
  process.env.DEVMATE_CONFIG = configPath;
  t.after(() => {
    if (previous === undefined) delete process.env.DEVMATE_CONFIG;
    else process.env.DEVMATE_CONFIG = previous;
  });

  const shared = await import(`${moduleUrl}?atomic=${Date.now()}`);
  shared.writeConfig({ version: 2, nested: { ready: true } });
  assert.deepEqual(shared.readConfig(), { version: 2, nested: { ready: true } });
  const entries = await fsp.readdir(directory);
  assert.deepEqual(entries, ['config.json']);
  if (process.platform !== 'win32') {
    const mode = fs.statSync(configPath).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test('rejects malformed configuration roots with the config path in the error', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-config-invalid-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  await fsp.writeFile(configPath, '[]\n', 'utf8');
  const previous = process.env.DEVMATE_CONFIG;
  process.env.DEVMATE_CONFIG = configPath;
  t.after(() => {
    if (previous === undefined) delete process.env.DEVMATE_CONFIG;
    else process.env.DEVMATE_CONFIG = previous;
  });
  const shared = await import(`${moduleUrl}?invalid=${Date.now()}`);
  assert.throws(() => shared.readConfig(), error => {
    assert.match(error.message, /Could not read DevMate config/);
    assert.match(error.message, /configuration root must be a JSON object/);
    return true;
  });
});
