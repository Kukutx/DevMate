#!/usr/bin/env python3
from pathlib import Path
import textwrap

root = Path(__file__).resolve().parents[1]


def read(name):
    return (root / name).read_text(encoding='utf-8')


def write(name, value):
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value.rstrip() + '\n', encoding='utf-8')


state_paths = read('host/runtime/state-paths.js')
old_normalizer = """function normalizedWorkspaceRoot(root) {
  const resolved = path.resolve(String(root || '.'));
  let real = resolved;
  try { real = fs.realpathSync.native(resolved); }
  catch { real = fs.realpathSync(resolved); }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}"""
new_normalizer = """function normalizedWorkspaceRoot(root) {
  const real = fs.realpathSync.native(path.resolve(String(root || '.')));
  return process.platform === 'win32' ? real.toLowerCase() : real;
}"""
if old_normalizer not in state_paths:
    raise RuntimeError('Could not enforce existing workspace roots')
write('host/runtime/state-paths.js', state_paths.replace(old_normalizer, new_normalizer, 1))

runtime_test = read('tests/runtime-controller.test.cjs')
old_test = """test('workspace runtime IDs are stable and path-specific', () => {
  const root = temporaryDirectory('devmate-runtime-id-');
  assert.equal(workspaceRuntimeId(root), workspaceRuntimeId(root));
  assert.notEqual(workspaceRuntimeId(root), workspaceRuntimeId(path.join(root, 'nested')));
});"""
new_test = """test('workspace runtime IDs are stable and path-specific', () => {
  const first = temporaryDirectory('devmate-runtime-id-first-');
  const second = temporaryDirectory('devmate-runtime-id-second-');
  assert.equal(workspaceRuntimeId(first), workspaceRuntimeId(first));
  assert.notEqual(workspaceRuntimeId(first), workspaceRuntimeId(second));
});"""
if old_test not in runtime_test:
    raise RuntimeError('Could not update workspace runtime ID test')
write('tests/runtime-controller.test.cjs', runtime_test.replace(old_test, new_test, 1))

write(
    'tests/no-legacy-runtime.test.cjs',
    textwrap.dedent(
        """
        'use strict';

        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const path = require('node:path');
        const test = require('node:test');

        const root = path.resolve(__dirname, '..');

        test('runtime contains no legacy state migration API or call sites', () => {
          const forbidden = new RegExp(['migrate', 'Legacy', 'State'].join(''));
          const legacyDirectory = new RegExp(['legacy', 'Directory'].join(''));
          for (const file of [
            'host/runtime/state-paths.js',
            'vscode-host/runtime-context.js',
            'obsidian-plugin/src/main.js'
          ]) {
            const source = fs.readFileSync(path.join(root, file), 'utf8');
            assert.doesNotMatch(source, forbidden, file);
            assert.doesNotMatch(source, legacyDirectory, file);
          }
          const statePaths = require('../host/runtime/state-paths.js');
          assert.equal(Object.keys(statePaths).some(key => forbidden.test(key)), false);
        });
        """
    )
)

(root / 'scripts/finalize_architecture_cleanup.py').unlink()
print('Completed final architecture cleanup.')
