'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('repository keeps only continuous CI and release workflows', () => {
  const files = fs.readdirSync(path.join(root, '.github', 'workflows'))
    .filter(name => /\.ya?ml$/i.test(name))
    .sort();
  assert.deepEqual(files, ['ci.yml', 'release.yml']);
});

test('package and lock file require current production host baselines', () => {
  const packageJson = require('../package.json');
  const packageLock = require('../package-lock.json');
  assert.equal(packageJson.engines.node, '>=24');
  assert.equal(packageJson.engines.vscode, '^1.132.0');
  assert.equal(packageLock.packages[''].engines.node, '>=24');
  assert.equal(packageLock.packages[''].engines.vscode, '^1.132.0');
});

test('CI, release, and Docker use Node 24 without legacy extension files', () => {
  const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const release = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
  const docker = fs.readFileSync(path.join(root, 'deploy', 'docker', 'Dockerfile'), 'utf8');
  assert.doesNotMatch(ci, /node-version:\s*22/);
  assert.doesNotMatch(release, /node-version:\s*22/);
  assert.match(ci, /standalone Docker build and network smoke/);
  assert.match(ci, /127\.0\.0\.1:18787:8787/);
  assert.match(docker, /^FROM node:24-bookworm-slim/m);
  assert.match(docker, /DEVMATE_BIND_HOST=0\.0\.0\.0/);
  assert.match(docker, /COPY shared \.\/shared/);
  assert.doesNotMatch(docker, /extension-entry-win32|ngrok-launch-compat|extension-config-io/);
});
