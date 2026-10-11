import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateVersions } from '../scripts/check-runtime.mjs';
import { VERSION } from '../runtime/version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the version is the one the owner approved in AGENTS.md, and any other number is stopped by the check', t => {
  validateVersions(root);
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-version-check-'));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  for (const name of ['package-lock.json', 'manifest.json', 'plugin.json', 'versions.json', 'CHANGELOG.md', 'AGENTS.md']) fs.copyFileSync(path.join(root, name), path.join(copy, name));
  validateVersions(copy);
  const rules = fs.readFileSync(path.join(copy, 'AGENTS.md'), 'utf8'), line = '- Owner-approved version: ' + VERSION + '.';
  assert.ok(rules.includes(line), 'AGENTS.md states the approved version');
  // Someone raised the number everywhere a release states it, but the owner did not approve it.
  const [major, minor, patch] = VERSION.split('.').map(Number), raised = [major, minor, patch + 1].join('.');
  fs.writeFileSync(path.join(copy, 'AGENTS.md'), rules.replace(line, '- Owner-approved version: ' + raised + '.'));
  assert.throws(() => validateVersions(copy), error => error.message.includes('the owner approved ' + raised) && /Only the owner changes it/.test(error.message));
  // The line cannot be dropped to get past the check.
  fs.writeFileSync(path.join(copy, 'AGENTS.md'), rules.replace(line, '- The version number changes only when the owner says so.'));
  assert.throws(() => validateVersions(copy), /AGENTS\.md must state the version the owner approved/);
});
