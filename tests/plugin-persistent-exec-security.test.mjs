import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const pluginRuntime = fs.readFileSync(new URL('../gateway/plugins/plugin-runtime.mjs', import.meta.url), 'utf8');
const persistent = fs.readFileSync(new URL('../gateway/persistent-processes.mjs', import.meta.url), 'utf8');

test('structured plugin executable launches never reconstruct a shell command', () => {
  assert.match(pluginRuntime, /startPersistentExecutable\(\{ workspaceId, executable, args, cwd, label, environment, autoStopAfterMs \}\)/);
  assert.doesNotMatch(pluginRuntime, /quoteShellArg|startPersistentProcess\(\{ workspaceId, command/);
});

test('persistent executable path passes argv to spawn with shell disabled', () => {
  assert.match(persistent, /const spawnArgs = shell \? \[\] : args\.map\(value => String\(value\)\)/);
  assert.match(persistent, /const child = spawn\(spawnCommand, spawnArgs, \{/);
  assert.match(persistent, /cwd: directory, shell, windowsHide: true/);
  assert.match(persistent, /startPersistentChild\(\{ workspaceId, executable: target, args, shell: false/);
});

test('raw persistent commands remain the only explicit shell=true path', () => {
  assert.match(persistent, /startPersistentChild\(\{ workspaceId, command, shell: true/);
  assert.match(persistent, /if \(shell\) assertCommandAllowed\(config, command\)/);
});
