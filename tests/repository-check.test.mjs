import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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

test('setting a version states it in every file that carries one, the browser extension among them, and makes what was collected for the next release its section', t => {
  // On a copy of the files the script writes: nothing of the repository is changed.
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-set-version-'));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  for (const name of ['scripts/set-version.mjs', 'package.json', 'package-lock.json', 'plugin.json', 'manifest.json', 'versions.json', 'chrome-extension/manifest.json', 'runtime/version.mjs']) {
    fs.mkdirSync(path.dirname(path.join(copy, name)), { recursive: true }); fs.copyFileSync(path.join(root, name), path.join(copy, name));
  }
  const changelog = path.join(copy, 'CHANGELOG.md'), headings = () => fs.readFileSync(changelog, 'utf8').split(/\r?\n/).filter(line => line.startsWith('## '));
  const set = () => spawnSync(process.execPath, [path.join(copy, 'scripts', 'set-version.mjs'), '9.8.7'], { encoding: 'utf8', windowsHide: true });
  const stated = file => JSON.parse(fs.readFileSync(path.join(copy, file), 'utf8')).version;
  fs.writeFileSync(changelog, '# Changelog\n\n## Unreleased\n- something new\n\n## ' + VERSION + '\n- before\n');
  const done = set();
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /The "## Unreleased" section of CHANGELOG\.md is now "## 9\.8\.7"/);
  assert.deepEqual(headings(), ['## 9.8.7', '## ' + VERSION]);
  assert.deepEqual(['package.json', 'plugin.json', 'manifest.json', 'chrome-extension/manifest.json'].map(stated), ['9.8.7', '9.8.7', '9.8.7', '9.8.7']);
  assert.match(fs.readFileSync(path.join(copy, 'runtime', 'version.mjs'), 'utf8'), /^export const VERSION = '9\.8\.7';/);
  // Entries written under a new "Unreleased" beside the version's own section would be left out of the release
  // notes: refused, before anything is written.
  fs.writeFileSync(changelog, '# Changelog\n\n## Unreleased\n- one more\n\n## 9.8.7\n- something new\n');
  fs.writeFileSync(path.join(copy, 'plugin.json'), fs.readFileSync(path.join(copy, 'plugin.json'), 'utf8').replace('"9.8.7"', '"0.0.1"'));
  const refused = set();
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /CHANGELOG\.md has both "## Unreleased" and "## 9\.8\.7"/);
  assert.equal(stated('plugin.json'), '0.0.1', 'nothing was written by the run that was refused');
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
