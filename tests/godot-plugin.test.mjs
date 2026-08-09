import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __test as godotTest, parseExportPresets, parseGodotConfig, parseGodotDiagnostics } from '../gateway/plugins/godot.mjs';
import { resolveProjectChild } from '../gateway/plugins/godot-project.mjs';

test('parses Godot project configuration sections', () => {
  const parsed = parseGodotConfig(`
[application]
config/name="Example Game"
run/main_scene="res://main.tscn"

[rendering]
renderer/rendering_method="gl_compatibility"
`);
  assert.equal(parsed.get('application')['config/name'], 'Example Game');
  assert.equal(parsed.get('rendering')['renderer/rendering_method'], 'gl_compatibility');
});

test('parses Web export presets', () => {
  const presets = parseExportPresets(`
[preset.0]
name="Web"
platform="Web"
runnable=true
export_path="build/web/index.html"

[preset.1]
name="Linux"
platform="Linux/X11"
`);
  assert.equal(presets.length, 2);
  assert.deepEqual(presets[0], { index: 0, name: 'Web', platform: 'Web', runnable: true, exportPath: 'build/web/index.html', dedicatedServer: false });
});

test('extracts Godot errors and warnings', () => {
  const diagnostics = parseGodotDiagnostics('WARNING: Slow path', 'SCRIPT ERROR: Parse Error: Unexpected token at: res://player.gd:18:4');
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].severity, 'warning');
  assert.equal(diagnostics[1].severity, 'error');
  assert.equal(diagnostics[1].line, 18);
});

test('rejects Godot scenes outside the project', () => {
  assert.throws(() => godotTest.normalizeScene('../outside.tscn'), /inside the project/);
  assert.equal(godotTest.normalizeScene('res://levels/arena.tscn'), 'res://levels/arena.tscn');
});

test('Godot project child paths cannot escape through symlink or reparse points', t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-godot-project-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-godot-outside-'));
  const link = path.join(project, 'escape');
  try {
    fs.writeFileSync(path.join(outside, 'secret.gd'), 'extends Node\n');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`symlink creation unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => resolveProjectChild(project, 'escape/secret.gd', { mustExist: true }),
      /symlink|reparse/i
    );
    assert.equal(resolveProjectChild(project, 'safe/new.gd'), path.join(project, 'safe', 'new.gd'));
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
