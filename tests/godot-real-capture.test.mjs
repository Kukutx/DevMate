import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runMovieCapture } from '../gateway/plugins/godot-performance.mjs';
import { installQaBridge } from '../gateway/plugins/godot-qa-bridge.mjs';
import { runExecutable } from '../gateway/plugins/plugin-runtime.mjs';

const godotExecutable = String(process.env.GODOT_REAL_BIN || '').trim();
const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'godot-real');

function contextFor(root) {
  const workspace = { id: 'real-capture', name: 'real-capture', root, mode: 'workspace-write', reference: false };
  return {
    settings: { executablePath: godotExecutable, defaultProjectSubpath: '.', validationTimeoutMs: 120000, exportTimeoutMs: 120000 },
    workspace: {
      get() { return workspace; },
      resolve(_workspace, subpath) {
        const target = path.resolve(root, subpath || '.');
        const relative = path.relative(root, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path escapes real Godot capture fixture');
        return target;
      }
    },
    executables: {
      find(candidates = []) { return candidates.some(value => String(value || '') === godotExecutable) ? godotExecutable : null; },
      assertAllowed(value) { return value; },
      run(executable, args, options) { return runExecutable(executable, args, options); }
    }
  };
}

test('records a deterministic AVI through the real Godot movie writer', { skip: !godotExecutable }, async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-real-capture-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.cp(fixtureRoot, root, { recursive: true });
  const context = contextFor(root);
  await installQaBridge(context, {});

  const captured = await runMovieCapture(context, {
    scene: 'res://capture.tscn',
    moviePath: 'artifacts/godot-capture/real.avi',
    reportPath: 'artifacts/godot-capture/real.json',
    fps: 15,
    frames: 30,
    performance: true,
    performanceBudgets: { minSamples: 1, maxNodeCount: 1000 },
    assertions: [{ statePath: 'capture.ready', operator: 'truthy' }],
    requiredCheckpoints: ['capture_started'],
    timeoutMs: 180000
  });

  assert.equal(captured.ok, true, JSON.stringify({ diagnostics: captured.diagnostics, checks: captured.checks, capture: captured.capture, performance: captured.performance, stderr: captured.result.stderr }));
  assert.equal(captured.capture.exists, true);
  assert.equal(captured.capture.bytes > 1024, true);
  assert.equal(captured.report.runtime.bridge_version, 3);
  assert.equal(captured.report.runtime.elapsed_frames >= 30, true);
});
