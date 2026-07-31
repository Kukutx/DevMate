import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installQaBridge } from '../gateway/plugins/godot-qa-bridge.mjs';
import { runNativeQa } from '../gateway/plugins/godot-native-qa.mjs';
import { validateProject } from '../gateway/plugins/godot-project.mjs';
import { inspectGodotRuntime } from '../gateway/plugins/godot-runtime.mjs';
import { runExecutable } from '../gateway/plugins/plugin-runtime.mjs';

const godotExecutable = String(process.env.GODOT_REAL_BIN || '').trim();
const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'godot-real');

function contextFor(root) {
  const workspace = { id: 'real-godot', name: 'real-godot', root, mode: 'workspace-write', reference: false };
  return {
    settings: {
      executablePath: godotExecutable,
      defaultProjectSubpath: '.',
      validationTimeoutMs: 120000,
      exportTimeoutMs: 120000
    },
    workspace: {
      get() { return workspace; },
      resolve(_workspace, subpath, { mustExist = false, directory = false } = {}) {
        const target = path.resolve(root, subpath || '.');
        const relative = path.relative(root, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path escapes real Godot fixture');
        return target;
      }
    },
    executables: {
      find(candidates = []) {
        return candidates.some(value => String(value || '') === godotExecutable) ? godotExecutable : null;
      },
      assertAllowed(value) { return value; },
      run(executable, args, options) { return runExecutable(executable, args, options); }
    }
  };
}

test('validates generated QA Bridge and runs native acceptance in real Godot', { skip: !godotExecutable }, async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-real-godot-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.cp(fixtureRoot, root, { recursive: true });
  await installQaBridge(root);
  const context = contextFor(root);

  const runtime = await inspectGodotRuntime(context, { timeoutMs: 30000 });
  assert.equal(runtime.ok, true, runtime.versionResult.stderr || runtime.versionResult.stdout);
  assert.equal(runtime.version.major >= 4, true);

  const validation = await validateProject(context, { timeoutMs: 120000 });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics));

  const native = await runNativeQa(context, {
    scene: 'res://main.tscn',
    headless: true,
    runForMs: 15000,
    quitOnCheckpoint: 'fixture_ready',
    assertions: [
      { statePath: 'fixture.ready', operator: 'truthy' },
      { statePath: 'fixture.value', operator: 'eq', value: 42 }
    ],
    requiredCheckpoints: ['fixture_ready'],
    reportPath: 'artifacts/godot-qa/real-runtime.json',
    timeoutMs: 120000
  });
  assert.equal(native.ok, true, JSON.stringify({ diagnostics: native.diagnostics, checks: native.checks, reportError: native.reportError, stderr: native.result.stderr }));
  assert.equal(native.report.fixture.value, 42);
  assert.equal(native.report.runtime.bridge_version, 2);
});
