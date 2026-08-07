import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const gateway = fs.readFileSync(path.join(root, 'gateway', 'server.mjs'), 'utf8');
const cli = fs.readFileSync(path.join(root, 'scripts', 'standalone-runtime.mjs'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'host', 'runtime', 'process-controller.js'), 'utf8');
const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const obsidian = fs.readFileSync(path.join(root, 'obsidian-plugin', 'src', 'main.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('Gateway accepts credentials only from request headers', () => {
  assert.match(gateway, /authorization/);
  assert.match(gateway, /x-devmate-token/);
  assert.doesNotMatch(gateway, /searchParams\.get\('token'\)/);
});

test('connection URLs never embed owner credentials', () => {
  for (const source of [cli, controller, extension]) {
    assert.doesNotMatch(source, /searchParams\.set\('token'/);
    assert.doesNotMatch(source, /\?token=/);
  }
  assert.match(extension, /Authorization: `Bearer \$\{token\}`/);
});

test('VS Code and Obsidian expose separate bearer-token copy commands', () => {
  assert.match(extension, /devMate\.copyToken/);
  assert.match(extension, /copyConnectionToken/);
  assert.equal(packageJson.contributes.commands.some(command => command.command === 'devMate.copyToken'), true);
  assert.match(obsidian, /id: 'copy-token'/);
  assert.match(obsidian, /this\.controller\.ownerToken\(\)/);
  assert.match(controller, /ownerToken\(\)/);
});
