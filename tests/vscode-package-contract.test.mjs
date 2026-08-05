import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const commandIds = new Set((manifest.contributes?.commands || []).map(command => command.command));
const activationEvents = new Set(manifest.activationEvents || []);

test('VS Code manifest exposes host diagnostics and self-check commands', () => {
  for (const command of ['devMate.copyHostDiagnostics', 'devMate.hostSelfCheck']) {
    assert.equal(commandIds.has(command), true, `Missing contributed command ${command}`);
    assert.equal(activationEvents.has(`onCommand:${command}`), true, `Missing activation event for ${command}`);
  }
});

test('Gateway build is self-contained and does not externalize production packages', () => {
  const buildScript = String(manifest.scripts?.build || '');
  assert.match(buildScript, /scripts\/build-gateway\.mjs/);
  assert.doesNotMatch(buildScript, /packages[=:]external|--packages=external/);
  const builder = fs.readFileSync(path.join(root, 'scripts', 'build-gateway.mjs'), 'utf8');
  assert.match(builder, /packages:\s*['"]bundle['"]/);
  assert.match(builder, /external:\s*\[['"]vscode['"]\]/);
});
