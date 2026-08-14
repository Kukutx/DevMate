'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { activateInstanceWorkspace, ensureInstanceConfig } = require('../shared/config-store.cjs');
const { normalizedWorkspaceRoot } = require('../host/runtime/state-paths.js');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('refuses to initialize when an invalid interrupted replacement is the only config evidence', () => {
  const workspaceRoot = temporaryDirectory('devmate-invalid-replacement-root-');
  const state = temporaryDirectory('devmate-invalid-replacement-state-');
  const configFile = path.join(state, 'config.json');
  const replacement = `${configFile}.replace-interrupted`;
  fs.writeFileSync(replacement, '{incomplete', 'utf8');

  assert.throws(
    () => ensureInstanceConfig({ configFile, workspaceRoot }),
    error => {
      assert.equal(error.code, 'config_recovery_failed');
      assert.deepEqual(error.replacementCandidates, [replacement]);
      return true;
    }
  );
  assert.equal(fs.existsSync(configFile), false);
  assert.equal(fs.existsSync(replacement), true);
});

test('does not rename or overwrite a directory accidentally placed at config.json', () => {
  const workspaceRoot = temporaryDirectory('devmate-config-directory-root-');
  const state = temporaryDirectory('devmate-config-directory-state-');
  const configFile = path.join(state, 'config.json');
  fs.mkdirSync(configFile);
  fs.writeFileSync(path.join(configFile, 'keep.txt'), 'preserve');

  assert.throws(
    () => ensureInstanceConfig({ configFile, workspaceRoot }),
    error => error.code === 'config_not_file'
  );
  assert.equal(fs.statSync(configFile).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(configFile, 'keep.txt'), 'utf8'), 'preserve');
  assert.equal(fs.readdirSync(state).some(name => name.includes('.corrupt-')), false);
});

test('registers multiple workspace roots in one desktop state without changing the active workspace implicitly', () => {
  const firstRoot = temporaryDirectory('devmate-binding-first-');
  const secondRoot = temporaryDirectory('devmate-binding-second-');
  const state = temporaryDirectory('devmate-binding-state-');
  const configFile = path.join(state, 'config.json');
  const first = ensureInstanceConfig({ configFile, workspaceRoot: firstRoot, appVersion: '3.3.9' });
  const second = ensureInstanceConfig({ configFile, workspaceRoot: secondRoot, appVersion: '3.3.0' });
  assert.equal(second.hostRuntime.workspaceRoot, undefined);
  assert.equal(second.appVersion, '3.3.9');
  assert.equal(second.workspaces.length, 2);
  assert.equal(second.activeWorkspaceId, first.activeWorkspaceId);
  assert.ok(second.workspaces.some(item => normalizedWorkspaceRoot(item.root) === normalizedWorkspaceRoot(secondRoot)));

  const activated = activateInstanceWorkspace({ configFile, workspaceRoot: secondRoot });
  const active = activated.workspaces.find(item => item.id === activated.activeWorkspaceId);
  assert.equal(normalizedWorkspaceRoot(active.root), normalizedWorkspaceRoot(secondRoot));
  assert.equal(activated.workspaces.filter(item => item.role === 'active').length, 1);
});
