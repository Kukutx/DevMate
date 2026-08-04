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
    'node scripts/check-release-tag.mjs',
    'npm run test:unit',
    'npm run smoke:gateway',
    'SHA256SUMS',
    'actions/attest@v4',
    'gh release create'
  ]) assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
