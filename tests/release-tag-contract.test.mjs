import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { expectedReleaseTag, validateReleaseTag } from '../scripts/check-release-tag.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('requires the release tag to exactly match package semantic version', () => {
  assert.equal(expectedReleaseTag('3.1.0'), 'v3.1.0');
  assert.deepEqual(validateReleaseTag('3.1.0-beta.1', 'v3.1.0-beta.1'), {
    version: '3.1.0-beta.1', tag: 'v3.1.0-beta.1'
  });
  assert.throws(() => validateReleaseTag('3.1.0', 'v3.0.0'), /does not match/);
  assert.throws(() => expectedReleaseTag('latest'), /Invalid package version/);
});

test('release workflow verifies, packages, checksums, attests, and publishes assets', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
  for (const required of [
    'git merge-base --is-ancestor',
    'node scripts/check-release-tag.mjs',
    'npm run test:unit',
    'npm run smoke:gateway',
    'npm run package:obsidian',
    'provider-supervisor.cjs',
    'gateway/server.mjs',
    'scripts/package-portable.mjs',
    'scripts/smoke-portable-cli.mjs',
    'devmate-${version}-windows-x64.zip',
    'devmate-${version}-linux-x64.tar.gz',
    'SHA256SUMS',
    'gh release create'
  ]) assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(workflow, /actions\/attest@[a-f0-9]{40}\b/i);
});

test('portable packaging installs production dependencies for the target platform', async () => {
  const { __test } = await import('../scripts/package-portable.mjs');
  assert.deepEqual(__test.productionInstallArgs('win32', 'x64'), [
    'ci',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--os=win32',
    '--cpu=x64'
  ]);
  assert.deepEqual(__test.productionInstallArgs('linux', 'arm64').slice(-2), [
    '--os=linux',
    '--cpu=arm64'
  ]);
  if (process.platform === 'win32') {
    assert.equal(__test.npmCommand().shell, false);
    assert.match(__test.npmCommand().command, /(?:cmd|node)(?:\.exe)?$/i);
  }
});
