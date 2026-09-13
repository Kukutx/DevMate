import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
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
const { choosePort, healthAt, healthMatches, isPortFree, sameDevMateInstance } = require('../host/runtime/network.js');
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
  const workspace = path.join(root, 'workspace');
  await fsp.mkdir(workspace, { recursive: true });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let index = 0;
  for (const value of ['abc', '8787.5', '1', '65536', -1, 70000, true]) {
    const config = path.join(root, `bad-${index++}`, 'config.json');
    assert.throws(
      () => cli.initConfig({ config, workspace, mode: 'personal', provider: 'ngrok', port: value }),
      error => error?.code === 'DEVMATE_PORT_INVALID'
    );
    assert.equal(fs.existsSync(config), false);
  }

  const valid = cli.initConfig({
    config: path.join(root, 'valid', 'config.json'),
    workspace,
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

test('Gateway identity checks reject a health response from the wrong port', () => {
  const config = { server: { port: 8787 }, appVersion: '3.8.6', instanceId: 'fixed-instance' };
  const health = { ok: true, json: { name: 'devmate', version: '3.8.6', instanceId: 'fixed-instance', port: 8788 } };
  assert.equal(healthMatches(health, config), false);
  assert.equal(sameDevMateInstance(health, config), false);
});

test('desktop Gateway port stays fixed instead of hopping when the configured port is occupied', async t => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name: 'other-service' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const config = { server: { port }, appVersion: '3.8.6', instanceId: 'fixed-instance' };

  await assert.rejects(
    choosePort(config, DEFAULT_PORT),
    error => error?.code === 'DEVMATE_GATEWAY_PORT_CONFLICT' && error.port === port
  );
  assert.equal(config.server.port, port);
});

test('same-instance old Gateway is marked stale on the fixed port instead of selecting the next port', async t => {
  const server = http.createServer((request, response) => {
    if (request.url === '/control/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ name: 'devmate', version: '3.8.5', instanceId: 'fixed-instance', port: server.address().port }));
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const config = { server: { port }, appVersion: '3.8.6', instanceId: 'fixed-instance' };

  const choice = await choosePort(config, DEFAULT_PORT);
  assert.equal(choice.port, port);
  assert.equal(choice.attached, false);
  assert.equal(choice.stale, true);
  assert.equal(choice.health.version, '3.8.5');
});
