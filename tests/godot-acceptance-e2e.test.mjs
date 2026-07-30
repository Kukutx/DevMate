import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { godotPlugin } from '../gateway/plugins/godot.mjs';

test('orchestrates Godot validation, Web export, preview, and Browser QA through services', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-godot-e2e-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, 'project.godot'), '[application]\nconfig/name="Fake Game"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n', 'utf8');
  await fsp.writeFile(path.join(root, 'export_presets.cfg'), '[preset.0]\nname="Web"\nplatform="Web"\nrunnable=true\n', 'utf8');
  const tools = new Map();
  const browserService = {
    status: () => ({ available: true }),
    startPreview: async () => ({ id: 'preview-1', url: 'http://127.0.0.1:4173/', port: 4173 }),
    runScenario: async ({ screenshotPath, reportPath }) => ({
      ok: true,
      screenshotPath,
      reportPath,
      navigationError: null,
      actionError: null,
      pageState: { canvases: [{ visible: true, clientWidth: 1280, clientHeight: 720 }], qaState: { player: { health: 100 } } },
      pageErrors: [], consoleErrors: [], requestFailures: []
    })
  };
  const workspace = { id: 'workspace', name: 'workspace', root, mode: 'workspace-write', reference: false };
  const context = {
    settings: { executablePath: '', defaultProjectSubpath: '.', defaultWebPreset: 'Web', defaultWebOutput: 'build/web/index.html', validationTimeoutMs: 10000, exportTimeoutMs: 10000 },
    server: { registerTool(name, config, handler) { tools.set(name, { config, handler }); } },
    services: { get(name) { assert.equal(name, 'devmate.browser-qa'); return browserService; } },
    workspace: {
      get() { return workspace; },
      resolve(_workspace, subpath, options = {}) {
        const target = path.resolve(root, subpath || '.');
        const rel = path.relative(root, target);
        if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('escape');
        return target;
      }
    },
    executables: {
      find() { return 'godot'; },
      assertAllowed(value) { return value; },
      async run(_executable, args) {
        const exportIndex = args.findIndex(value => value === '--export-debug' || value === '--export-release');
        if (exportIndex >= 0) {
          const output = args[exportIndex + 2];
          await fsp.mkdir(path.dirname(output), { recursive: true });
          await fsp.writeFile(output, '<!doctype html><canvas></canvas>', 'utf8');
        }
        return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
      },
      async start() { return { id: 'proc-1' }; }
    },
    readConfig: () => ({ plugins: { settings: {} } }),
    toolText: payload => ({ structuredContent: payload }),
    audit: async () => {}
  };
  await godotPlugin.activate(context);
  const result = await tools.get('godot_acceptance_test').handler({ actions: [{ type: 'expect_state', statePath: 'player.health', operator: 'eq', value: 100 }] });
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.checks.visibleCanvas, true);
  assert.equal(result.structuredContent.checks.qaStateAvailable, true);
  assert.equal((await fsp.stat(path.join(root, 'build/web/index.html'))).isFile(), true);
});
