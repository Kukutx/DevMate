import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Obsidian host never installs or updates external dependencies', () => {
  const settings = source('obsidian-plugin/src/settings.js');
  assert.doesNotMatch(settings, /installCloudflared|cloudflaredInstallCommand/);
  assert.match(settings, /does not install or update external dependencies/);
  assert.match(settings, /developers\.cloudflare\.com\/tunnel\/setup/);
});

test('Community directory disclosures cover network and external file access', () => {
  for (const relative of ['README.md', 'obsidian-plugin/README.md']) {
    const readme = source(relative);
    assert.match(readme, /Network use:/);
    assert.match(readme, /Files outside the vault:/);
    assert.match(readme, /does not install or update/);
    assert.match(readme, /no client-side telemetry/);
  }
});

test('release documentation follows the current Community directory submission flow', () => {
  const releasing = source('docs/RELEASING.md');
  assert.match(releasing, /community\.obsidian\.md/);
  assert.match(releasing, /New plugin/);
  assert.doesNotMatch(releasing, /registry pull request|community plugin registry with this entry/i);
});

test('release downloads retry transient network failures', () => {
  const workflow = source('.github/workflows/release.yml');
  const retries = workflow.match(/--retry 5 --retry-delay 2 --retry-all-errors/g) || [];
  assert.equal(retries.length, 3);
});
