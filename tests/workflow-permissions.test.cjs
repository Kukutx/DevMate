'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const release = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const manifest = require('../obsidian-plugin/manifest.json');
const versions = require('../obsidian-plugin/versions.json');

function pinnedAction(name, major) {
  return new RegExp(`${name.replace('/', '\\/')}@[a-f0-9]{40}\\s+# v${major}`, 'i');
}

const requiredReleaseChecks = [
  'Windows, VS Code 1.133, Node 24 LTS',
  'Node 26 Current compatibility',
  'Linux and Real Godot 4.7.1'
];

test('permanent CI is read-only and never mutates source branches', () => {
  assert.match(ci, /permissions:[\s\S]*?contents:\s*read/);
  assert.doesNotMatch(ci, /contents:\s*write/);
  assert.doesNotMatch(ci, /architecture_convergence|git push origin|Commit validated architecture/);
});

test('permanent workflows pin current supported actions and use Node 24', () => {
  for (const source of [ci, release]) {
    assert.doesNotMatch(source, /node-version:\s*22/);
    assert.match(source, /node-version:\s*24/);
    assert.match(source, pinnedAction('actions/checkout', 7));
    assert.match(source, pinnedAction('actions/setup-node', 7));
  }
  assert.match(ci, pinnedAction('actions/upload-artifact', 7));
  assert.match(ci, pinnedAction('actions/cache', 6));
  assert.match(release, pinnedAction('actions/attest', 4));
  assert.match(release, pinnedAction('actions/upload-artifact', 7));
});

test('release authority is limited to publishing, CI verification, and provenance', () => {
  assert.match(release, /contents:\s*write/);
  assert.match(release, /checks:\s*read/);
  assert.match(release, /id-token:\s*write/);
  assert.match(release, /attestations:\s*write/);
  assert.match(release, /Verify required CI checks passed for tagged commit/);
  for (const checkName of requiredReleaseChecks) {
    assert.match(ci, new RegExp(`name:\\s*${checkName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(release.includes(`"${checkName}"`), true, `release must require CI check: ${checkName}`);
  }
  assert.equal(release.includes('for required in "verify"'), false);
  assert.doesNotMatch(release, /pull-requests:\s*write|issues:\s*write|actions:\s*write/);
});

test('Obsidian release metadata requires the verified stable host', () => {
  assert.equal(manifest.minAppVersion, '1.13.4');
  assert.equal(versions[manifest.version], '1.13.4');
});
