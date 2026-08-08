import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  doctor,
  initConfig,
  validateStandaloneIngress
} from '../scripts/standalone-runtime.mjs';

async function fixture() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-standalone-ingress-'));
  const workspace = path.join(directory, 'workspace');
  const config = path.join(directory, 'config.json');
  await fsp.mkdir(workspace, { recursive: true });
  return { directory, workspace, config };
}

test('standalone personal and team modes may leave public ingress separately managed', () => {
  for (const provider of ['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external']) {
    assert.deepEqual(validateStandaloneIngress({
      mode: 'team',
      provider,
      publicUrl: ''
    }), { mode: 'team', provider, publicUrl: '' });
  }
  assert.deepEqual(validateStandaloneIngress({
    mode: 'personal',
    provider: 'external',
    publicUrl: ''
  }), { mode: 'personal', provider: 'external', publicUrl: '' });
});

test('production rejects Quick Tunnel and requires stable URL for every provider', () => {
  assert.throws(() => validateStandaloneIngress({
    mode: 'production',
    provider: 'cloudflare-quick',
    publicUrl: ''
  }), /development-only/);
  for (const provider of ['ngrok', 'cloudflare-managed', 'external']) {
    assert.throws(() => validateStandaloneIngress({
      mode: 'production',
      provider,
      publicUrl: ''
    }), /Production mode requires --public-url/);
  }
});

test('standalone team external without a known public URL remains a valid local or separately-ingressed Gateway config', async () => {
  const value = await fixture();
  try {
    const result = initConfig({
      workspace: value.workspace,
      config: value.config,
      mode: 'team',
      provider: 'external'
    });
    assert.equal(result.config.deployment.tunnelProvider, 'external');
    assert.equal(result.config.deployment.publicUrl, '');
    assert.deepEqual(result.config.production.allowedHosts, []);
  } finally {
    await fsp.rm(value.directory, { recursive: true, force: true });
  }
});

test('standalone team external may record a stable public URL and Host allowlist when known', async () => {
  const value = await fixture();
  try {
    const result = initConfig({
      workspace: value.workspace,
      config: value.config,
      mode: 'team',
      provider: 'external',
      'public-url': 'https://standalone.example.test'
    });
    assert.equal(result.config.deployment.tunnelProvider, 'external');
    assert.equal(result.config.deployment.publicUrl, 'https://standalone.example.test');
    assert.deepEqual(result.config.production.allowedHosts, ['standalone.example.test']);
  } finally {
    await fsp.rm(value.directory, { recursive: true, force: true });
  }
});

test('standalone Doctor only makes public URL a hard requirement in production', async () => {
  const value = await fixture();
  try {
    initConfig({
      workspace: value.workspace,
      config: value.config,
      mode: 'team',
      provider: 'external'
    });
    const report = doctor({ config: value.config });
    assert.equal(report.checks.some(check => check.key === 'public-url'), false);
  } finally {
    await fsp.rm(value.directory, { recursive: true, force: true });
  }
});
