import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { safeGodotBaselinePath, safeGodotRelativePath } from '../gateway/plugins/godot-path-policy.mjs';
import { __test as baselineTest } from '../gateway/plugins/godot-baseline.mjs';
import { __test as bootstrapTest } from '../gateway/plugins/godot-bootstrap.mjs';
import { __test as nativeQaTest } from '../gateway/plugins/godot-native-qa.mjs';
import { __test as projectTest } from '../gateway/plugins/godot-project.mjs';
import { __test as releaseGateTest } from '../gateway/plugins/godot-release-gate.mjs';
import { __test as testsTest } from '../gateway/plugins/godot-tests.mjs';

test('Godot relative artifact paths reject traversal and protected workspace data', () => {
  assert.equal(safeGodotRelativePath('artifacts/godot/report.json'), 'artifacts/godot/report.json');
  for (const value of ['../escape.json', '.npmrc', '.aws/credentials', 'secrets/report.json', '.devmate/state.json']) {
    assert.throws(() => safeGodotRelativePath(value, '', 'Artifact path'), value);
  }
});

test('Godot baseline path permits only reviewed canonical baseline files inside .devmate', () => {
  assert.equal(
    safeGodotBaselinePath('.devmate/baselines/godot/main-linux-x64.json'),
    '.devmate/baselines/godot/main-linux-x64.json'
  );
  assert.equal(safeGodotBaselinePath('baselines/main.json'), 'baselines/main.json');
  for (const value of [
    '.devmate/baselines/godot/credentials.json',
    '.devmate/baselines/godot/nested/main.json',
    '.devmate/baselines/godot/main.key',
    '.devmate/state.json',
    '../main.json'
  ]) assert.throws(() => safeGodotBaselinePath(value), value);
});

test('Godot path-producing modules consistently reject protected destinations', () => {
  for (const fn of [
    value => baselineTest.safeRelative(value, 'artifacts/default.json'),
    value => bootstrapTest.safeRelative(value),
    value => nativeQaTest.safeRelative(value, 'artifacts/default.json'),
    value => projectTest.safeRelativeOutput(value),
    value => releaseGateTest.safeRelative(value, 'Release evidence'),
    value => testsTest.safeRelative(value, 'artifacts/default.xml')
  ]) {
    assert.throws(() => fn('.aws/credentials'));
    assert.throws(() => fn('../escape'));
  }
  assert.equal(bootstrapTest.safeRelative('.devmate/automation.json'), '.devmate/automation.json');
});

test('Godot relative paths reject absolute POSIX and platform-native absolute forms', () => {
  assert.throws(() => safeGodotRelativePath('/tmp/report.json'));
  const absolute = path.resolve('absolute-report.json');
  assert.throws(() => safeGodotRelativePath(absolute));
});
