import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { retiredWording, validateVersions } from '../scripts/check-runtime.mjs';
import { VERSION } from '../runtime/version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a measurement that reads like the number of an earlier version is not taken for one, and the version itself still is', () => {
  // Put together from pieces, as the check's own words are: this file is checked too.
  const number = '3.' + '8', family = '3.' + 'x';
  for (const measured of ['took ' + number + ' seconds', '用时 ' + number + ' 秒', number + 's', number + ' ms', number + ' MB', number + ' MiB', number + '%', '快了 ' + number + ' 倍'])
    assert.equal(retiredWording(measured), false, measured);
  for (const named of ['DevMate ' + number, 'state of ' + family, 'since ' + number + '.', 'the ' + number + ' settings', number + ' series', 'v' + number]) assert.equal(retiredWording(named), true, named);
  assert.equal(retiredWording('version 13.' + '8 and 3.' + '80'), false, 'another number that only holds these digits');
});

test('the version is the one the owner approved in AGENTS.md, and any other number is stopped by the check', t => {
  validateVersions(root);
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-version-check-'));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.mkdirSync(path.join(copy, 'chrome-extension'));
  for (const name of ['package-lock.json', 'manifest.json', 'plugin.json', 'versions.json', 'CHANGELOG.md', 'AGENTS.md', 'chrome-extension/manifest.json']) fs.copyFileSync(path.join(root, name), path.join(copy, name));
  validateVersions(copy);
  // The browser extension states the version too: a runtime replaces the copy a browser loads by that number.
  const extension = path.join(copy, 'chrome-extension', 'manifest.json'), stated = fs.readFileSync(extension, 'utf8');
  fs.writeFileSync(extension, stated.replace('"version": "' + VERSION + '"', '"version": "0.0.1"'));
  assert.throws(() => validateVersions(copy), /chrome-extension\/manifest\.json \(the browser extension\) states another version/);
  fs.writeFileSync(extension, stated);
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
