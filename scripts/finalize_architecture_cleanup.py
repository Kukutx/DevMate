#!/usr/bin/env python3
from pathlib import Path
import re
import textwrap

root = Path(__file__).resolve().parents[1]


def read(name):
    return (root / name).read_text(encoding='utf-8')


def write(name, value):
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value.rstrip() + '\n', encoding='utf-8')


# The single persistence core owns snapshot identity, compare-and-swap replacement,
# and retryable atomic mutation. No Gateway module may implement these semantics.
store = read('shared/config-store.cjs')
store = store.replace(
    "const { withFileLockSync } = require('../config-file-lock.cjs');",
    "const { withFileLockSync } = require('../config-file-lock.cjs');\nconst CONFIG_SNAPSHOT = Symbol.for('devmate.configSnapshot');",
    1
)
marker = 'function fsyncDirectory(directory) {'
snapshot_core = textwrap.dedent(
    """
    function fingerprint(value) {
      return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
    }

    function readConfigState(file) {
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat) return { exists: false, raw: '', hash: null, value: {} };
      if (!stat.isFile()) throw configError('DevMate config path is not a file', 'config_not_file', file);
      if (stat.size > MAX_CONFIG_BYTES) {
        const error = configError(`DevMate config exceeds ${MAX_CONFIG_BYTES} bytes (${stat.size} bytes)`, 'config_too_large', file);
        error.bytes = stat.size;
        error.maxBytes = MAX_CONFIG_BYTES;
        throw error;
      }
      let raw;
      let value;
      try {
        raw = fs.readFileSync(file, 'utf8').replace(/^\\uFEFF/, '');
        value = JSON.parse(raw);
      } catch (cause) {
        throw configError('DevMate config contains invalid JSON', 'config_invalid_json', file, cause);
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw configError('DevMate config root must be a JSON object', 'config_invalid_root', file);
      }
      assertSupportedConfigVersion(value, file);
      return { exists: true, raw, hash: fingerprint(raw), value };
    }

    function attachConfigSnapshot(value, file, state) {
      Object.defineProperty(value, CONFIG_SNAPSHOT, {
        value: Object.freeze({ file: path.resolve(file), exists: state.exists, hash: state.hash }),
        enumerable: false,
        configurable: false,
        writable: false
      });
      return value;
    }

    function readConfigSnapshot(file) {
      const target = path.resolve(file);
      recoverConfigReplacement(target);
      const state = readConfigState(target);
      return attachConfigSnapshot(state.value, target, state);
    }

    function configConflict(file) {
      const error = configError('DevMate config changed while it was being edited', 'config_conflict', file);
      return error;
    }

    """
)
if marker not in store:
    raise RuntimeError('Could not insert shared snapshot core')
store = store.replace(marker, snapshot_core + marker, 1)

update_pattern = re.compile(r"function updateConfig\(file, mutator\) \{.*?\n\}\n\nfunction randomToken\(\) \{", re.S)
update_core = textwrap.dedent(
    """
    function replaceConfig(file, value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw configError('DevMate config replacement requires a JSON object', 'config_invalid_write', file);
      }
      const target = path.resolve(file);
      const source = value[CONFIG_SNAPSHOT];
      if (!source || source.file !== target) {
        throw configError('DevMate config replacement requires a current snapshot', 'config_snapshot_required', target);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      return withFileLockSync(target, () => {
        recoverConfigReplacement(target);
        const current = readConfigState(target);
        if (current.exists !== source.exists || current.hash !== source.hash) throw configConflict(target);
        assertSupportedConfigVersion(value, target);
        atomicWriteJson(target, value);
        return readConfigSnapshot(target);
      });
    }

    function updateConfig(file, mutator, { retries = 3 } = {}) {
      if (typeof mutator !== 'function') throw new TypeError('Config mutator must be a function');
      const target = path.resolve(file);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const attempts = Math.min(10, Math.max(1, Math.trunc(Number(retries) || 3)));
      return withFileLockSync(target, () => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          recoverConfigReplacement(target);
          const beforeState = readConfigState(target);
          const current = attachConfigSnapshot(beforeState.value, target, beforeState);
          const beforeJson = JSON.stringify(current);
          const changed = mutator(current);
          if (changed && typeof changed.then === 'function') throw new TypeError('Config mutator must be synchronous');
          if (changed === false) return current;
          const next = changed === undefined ? current : changed;
          if (!next || typeof next !== 'object' || Array.isArray(next)) {
            throw configError('Config mutator must return a JSON object', 'config_invalid_write', target);
          }
          assertSupportedConfigVersion(next, target);
          const afterState = readConfigState(target);
          if (afterState.exists !== beforeState.exists || afterState.hash !== beforeState.hash) {
            if (attempt === attempts - 1) throw configConflict(target);
            continue;
          }
          if (beforeState.exists && JSON.stringify(next) === beforeJson) return current;
          atomicWriteJson(target, next);
          return readConfigSnapshot(target);
        }
        throw configConflict(target);
      });
    }

    function randomToken() {
    """
).rstrip()
store, count = update_pattern.subn(update_core, store, count=1)
if count != 1:
    raise RuntimeError('Could not replace shared updateConfig implementation')

exports_marker = '  readJson,\n'
if exports_marker not in store:
    raise RuntimeError('Could not export shared snapshot operations')
store = store.replace(
    exports_marker,
    '  readConfigSnapshot,\n  readJson,\n  replaceConfig,\n',
    1
)
write('shared/config-store.cjs', store)

shared = read('gateway/local-shared.mjs')
shared = shared.replace(
    "return configStore.readJson(CONFIG_PATH, null, { strict: true, supportedVersion: true });",
    "return configStore.readConfigSnapshot(CONFIG_PATH);",
    1
)
shared = shared.replace(
    "return configStore.updateConfig(CONFIG_PATH, () => config);",
    "return configStore.replaceConfig(CONFIG_PATH, config);",
    1
)
write('gateway/local-shared.mjs', shared)

persistence_test = read('tests/config-persistence.test.mjs')
old_atomic = """  shared.writeConfig({ version: 2, nested: { ready: true } });
  assert.deepEqual(shared.readConfig(), { version: 2, nested: { ready: true } });"""
new_atomic = """  const config = shared.readConfig();
  config.version = 2;
  config.nested = { ready: true };
  shared.writeConfig(config);
  assert.deepEqual(shared.readConfig(), { version: 2, nested: { ready: true } });"""
if old_atomic not in persistence_test:
    raise RuntimeError('Could not update snapshot write test')
persistence_test = persistence_test.replace(old_atomic, new_atomic, 1)
insert_after = """test('writes DevMate config atomically with valid JSON and no temporary files', async t => {
  const { directory, configPath, shared } = await withConfig(t, 'devmate-config-');
  const config = shared.readConfig();
  config.version = 2;
  config.nested = { ready: true };
  shared.writeConfig(config);
  assert.deepEqual(shared.readConfig(), { version: 2, nested: { ready: true } });
  const entries = await fsp.readdir(directory);
  assert.deepEqual(entries, ['config.json']);
  if (process.platform !== 'win32') {
    const mode = fs.statSync(configPath).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});
"""
unsourced_test = textwrap.dedent(
    """

    test('rejects unsourced whole-document replacement', async t => {
      const { shared } = await withConfig(t, 'devmate-config-unsourced-', { version: 1, keep: true });
      assert.throws(() => shared.writeConfig({ version: 1, replace: true }), error => {
        assert.equal(error.code, 'config_snapshot_required');
        return true;
      });
      assert.deepEqual(shared.readConfig(), { version: 1, keep: true });
    });
    """
)
if insert_after not in persistence_test:
    raise RuntimeError('Could not insert unsourced replacement test')
persistence_test = persistence_test.replace(insert_after, insert_after + unsourced_test, 1)
write('tests/config-persistence.test.mjs', persistence_test)

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
