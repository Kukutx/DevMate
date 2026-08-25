import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { doctor, initConfig, validateStandaloneIngress } from '../scripts/standalone-runtime.mjs';

async function fixture() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-standalone-ingress-'));
  const workspace = path.join(directory, 'workspace');
  const config = path.join(directory, 'config.json');
  await fsp.mkdir(workspace, { recursive: true });
  return { directory, workspace, config };
}

test('temporary managed connection providers may omit a stable URL only when the provider supports it', () => {
  for (const provider of ['ngrok', 'cloudflare-quick']) {
    assert.deepEqual(validateStandaloneIngress({ provider, publicUrl: '' }), { provider, publicUrl: '' });
  }
});

test('managed Cloudflare and external ingress require an explicit stable HTTPS URL', () => {
  for (const provider of ['cloudflare-managed', 'external']) {
    assert.throws(() => validateStandaloneIngress({ provider, publicUrl: '' }), /requires --public-url/);
    assert.throws(() => validateStandaloneIngress({ provider, publicUrl: 'http://devmate.example.com' }), /HTTPS/);
  }
});

test('standalone external connection records the public URL without inventing a Host restriction', async () => {
  const value = await fixture();
  try {
    const result = initConfig({
      workspace: value.workspace,
      config: value.config,
      provider: 'external',
      'public-url': 'https://standalone.example.test'
    });
    assert.equal(result.config.connection.provider, 'external');
    assert.equal(result.config.connection.publicUrl, 'https://standalone.example.test');
    assert.deepEqual(result.config.auth, { mode: 'none' });
    assert.deepEqual(result.config.requestPolicy.allowedHosts, []);
    assert.equal('deployment' in result.config, false);
    assert.equal('production' in result.config, false);
  } finally {
    await fsp.rm(value.directory, { recursive: true, force: true });
  }
});

test('standalone may explicitly restrict the public Host independently of connection provider', async () => {
  const value = await fixture();
  try {
    const result = initConfig({
      workspace: value.workspace,
      config: value.config,
      provider: 'external',
      'public-url': 'https://standalone.example.test',
      'restrict-public-host': true
    });
    assert.deepEqual(result.config.requestPolicy.allowedHosts, ['standalone.example.test']);
  } finally {
    await fsp.rm(value.directory, { recursive: true, force: true });
  }
});

test('standalone Doctor validates public URL and explicit Host policy from active capabilities', async () => {
  const value = await fixture();
  try {
    initConfig({
      workspace: value.workspace,
      config: value.config,
      provider: 'external',
      'public-url': 'https://standalone.example.test',
      'restrict-public-host': true
    });
    const report = doctor({ config: value.config });
    assert.equal(report.checks.find(check => check.key === 'public-url')?.ok, true);
    assert.equal(report.checks.find(check => check.key === 'allowed-hosts')?.ok, true);
  } finally {
    await fsp.rm(value.directory, { recursive: true, force: true });
  }
});