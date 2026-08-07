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

test('permanent CI is read-only and never mutates source branches', () => {
  assert.match(ci, /permissions:[\s\S]*?contents:\s*read/);
  assert.doesNotMatch(ci, /contents:\s*write/);
  assert.doesNotMatch(ci, /architecture_convergence|git push origin|Commit validated architecture/);
});

test('permanent workflows use current supported action majors and Node 24', () => {
  for (const source of [ci, release]) {
    assert.doesNotMatch(source, /node-version:\s*22/);
    assert.match(source, /node-version:\s*24/);
    assert.match(source, /actions\/checkout@v7/);
    assert.match(source, /actions\/setup-node@v7/);
  }
  assert.match(ci, /actions\/upload-artifact@v7/);
  assert.match(ci, /actions\/cache@v6/);
  assert.match(release, /actions\/attest@v4/);
  assert.match(release, /actions\/upload-artifact@v7/);
});

test('release authority is limited to publishing, CI verification, and provenance', () => {
  assert.match(release, /contents:\s*write/);
  assert.match(release, /checks:\s*read/);
  assert.match(release, /id-token:\s*write/);
  assert.match(release, /attestations:\s*write/);
  assert.match(release, /Verify required CI checks passed for tagged commit/);
  assert.match(release, /"verify" "Linux and Real Godot 4\.7\.1"/);
  assert.doesNotMatch(release, /pull-requests:\s*write|issues:\s*write|actions:\s*write/);
});

test('Obsidian release metadata requires the verified stable host', () => {
  assert.equal(manifest.minAppVersion, '1.13.4');
  assert.equal(versions[manifest.version], '1.13.4');
});
