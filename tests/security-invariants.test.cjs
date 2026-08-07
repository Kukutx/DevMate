'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function repositorySource() {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && /\.(?:js|cjs|mjs)$/i.test(entry.name)) files.push(full);
    }
  };
  visit(root);
  return files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
}

test('authentication tokens are never accepted from URL query parameters', () => {
  const source = repositorySource();
  assert.doesNotMatch(source, /searchParams\.get\(\s*['"]token['"]\s*\)/);
  assert.doesNotMatch(source, /[?&]token=/);
});

test('credential rotation does not implicitly reactivate revoked identities', () => {
  for (const relative of ['gateway/team-access.mjs', 'gateway/runner-access.mjs']) {
    const source = read(relative);
    const rotateStart = source.search(/export function rotate(?:TeamMemberToken|RunnerCredentialToken)/);
    assert.ok(rotateStart >= 0, relative);
    const nextExport = source.indexOf('\nexport function ', rotateStart + 20);
    const body = source.slice(rotateStart, nextExport < 0 ? source.length : nextExport);
    assert.doesNotMatch(body, /disabled\s*=\s*false/, relative);
  }
});

test('workspace name compatibility never uses first-match id-or-name lookup', () => {
  const source = repositorySource();
  assert.doesNotMatch(source, /\.find\([^\n]{0,180}\.id\s*===\s*[^\n]{0,120}\|\|[^\n]{0,120}\.name\s*===/);
});

test('Runner API matching is version-boundary safe', () => {
  const source = read('gateway/runner-control-plane.mjs');
  assert.match(source, /url\.pathname !== PREFIX && !url\.pathname\.startsWith\(`\$\{PREFIX\}\//);
  assert.doesNotMatch(source, /if \(!url\?\.pathname\.startsWith\(PREFIX\)\)/);
});

test('production Host policy fails closed when no allowlist exists', () => {
  for (const relative of ['gateway/request-guard.mjs', 'gateway/runner-control-plane.mjs']) {
    const source = read(relative);
    assert.match(source, /!allowed\.length\)[^\n]*deployment\?\.mode !== ['"]production['"]/, relative);
  }
});

test('explicit invalid config and durable-state versions are rejected', () => {
  assert.match(read('shared/config-store.cjs'), /invalid_config_version/);
  assert.match(read('gateway/durable-state.mjs'), /invalid_state_version/);
});
