import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
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

test('standalone external and Cloudflare managed require stable HTTPS origins', () => {
  assert.throws(() => validateStandaloneIngress({
    mode: 'team',
    provider: 'external',
    publicUrl: ''
  }), /external requires --public-url/);
  assert.throws(() => validateStandaloneIngress({
    mode: 'team',
    provider: 'cloudflare-managed',
    publicUrl: ''
  }), /cloudflare-managed requires --public-url/);
});

test('team ngrok and Cloudflare Quick may start without configured stable URLs', () => {
  assert.deepEqual(validateStandaloneIngress({
    mode: 'team',
    provider: 'ngrok',
    publicUrl: ''
  }), { mode: 'team', provider: 'ngrok', publicUrl: '' });
  assert.deepEqual(validateStandaloneIngress({
    mode: 'team',
    provider: 'cloudflare-quick',
    publicUrl: ''
  }), { mode: 'team', provider: 'cloudflare-quick', publicUrl: '' });
});

test('production rejects Quick Tunnel and requires stable URL for ngrok', () => {
  assert.throws(() => validateStandaloneIngress({
    mode: 'production',
    provider: 'cloudflare-quick',
    publicUrl: ''
  }), /development-only/);
  assert.throws(() => validateStandaloneIngress({
    mode: 'production',
    provider: 'ngrok',
    publicUrl: ''
  }), /Production mode requires --public-url/);
});

test('standalone init refuses incomplete external state without writing config', async () => {
  const value = await fixture();
  try {
    assert.throws(() => initConfig({
      workspace: value.workspace,
      config: value.config,
      mode: 'team',
      provider: 'external'
    }), /external requires --public-url/);
    await assert.rejects(fsp.stat(value.config));
  } finally {
    await fsp.rm(value.directory, { recursive: true, force: true });
  }
});

test('standalone init persists complete external state and Host allowlist', async () => {
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
