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
  const set = (version = '9.8.7') => spawnSync(process.execPath, [path.join(copy, 'scripts', 'set-version.mjs'), version], { encoding: 'utf8', windowsHide: true });
  const stated = file => JSON.parse(fs.readFileSync(path.join(copy, file), 'utf8')).version, everywhere = () => ['package.json', 'plugin.json', 'manifest.json', 'chrome-extension/manifest.json'].map(stated);
  const collected = '# Changelog\n\n## Unreleased\n- something new\n\n## ' + VERSION + '\n- before\n', versions = fs.readFileSync(path.join(copy, 'versions.json'), 'utf8');
  fs.writeFileSync(changelog, collected);
  const done = set();
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /The "## Unreleased" section of CHANGELOG\.md is now "## 9\.8\.7"/);
  assert.deepEqual(headings(), ['## 9.8.7', '## ' + VERSION]);
  assert.deepEqual(everywhere(), ['9.8.7', '9.8.7', '9.8.7', '9.8.7']);
  assert.match(fs.readFileSync(path.join(copy, 'runtime', 'version.mjs'), 'utf8'), /^export const VERSION = '9\.8\.7';/);
  assert.ok('9.8.7' in JSON.parse(fs.readFileSync(path.join(copy, 'versions.json'), 'utf8')));
  // Setting the version back takes all of that back: the section waits for the next release again, and no file names
  // a release that never was. (Left as it was, the section would stay under a number nothing is released by, and the
  // version that is released later would pass with an empty section of its own.)
  const back = set(VERSION);
  assert.equal(back.status, 0, back.stderr);
  assert.match(back.stdout, new RegExp('What was collected for 9\\.8\\.7 is under "## Unreleased" of CHANGELOG\\.md again, and versions\\.json no longer names 9\\.8\\.7'));
  assert.deepEqual([fs.readFileSync(changelog, 'utf8'), fs.readFileSync(path.join(copy, 'versions.json'), 'utf8'), everywhere()], [collected, versions, Array(4).fill(VERSION)]);
  assert.match(fs.readFileSync(path.join(copy, 'runtime', 'version.mjs'), 'utf8'), new RegExp('^export const VERSION = \'' + VERSION.replace(/\./g, '\\.') + '\';'));
  // Taken back where entries were already collected anew: neither section is chosen for the other, and nothing is written.
  assert.equal(set().status, 0);
  fs.writeFileSync(changelog, '# Changelog\n\n## Unreleased\n- one more\n\n## 9.8.7\n- something new\n\n## ' + VERSION + '\n- before\n');
  const both = set(VERSION);
  assert.notEqual(both.status, 0); assert.match(both.stderr, /CHANGELOG\.md has both "## Unreleased" and "## 9\.8\.7", the version that is taken back/);
  assert.deepEqual(everywhere(), Array(4).fill('9.8.7'), 'nothing was written by the run that was refused');
  // Taken back where the changelog was never given a section for it (the number was set by hand): what is collected
  // stays where it is, beside the section of the version that is stated again.
  fs.writeFileSync(changelog, collected);
  const plain = set(VERSION);
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual([fs.readFileSync(changelog, 'utf8'), fs.readFileSync(path.join(copy, 'versions.json'), 'utf8'), everywhere()], [collected, versions, Array(4).fill(VERSION)]);
  // Entries written under a new "Unreleased" beside the version's own section would be left out of the release
  // notes: refused, before anything is written.
  fs.writeFileSync(changelog, '# Changelog\n\n## Unreleased\n- one more\n\n## 9.8.7\n- something new\n');
  fs.writeFileSync(path.join(copy, 'plugin.json'), fs.readFileSync(path.join(copy, 'plugin.json'), 'utf8').replace('"version": "' + VERSION + '"', '"version": "0.0.1"'));
  const refused = set();
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /CHANGELOG\.md has both "## Unreleased" and "## 9\.8\.7"/);
  assert.equal(stated('plugin.json'), '0.0.1', 'nothing was written by the run that was refused');
});

test('every notification and input box of the editor host is shown through the one place that keeps its text from forming a link', () => {
  // VS Code makes a link of "[label](address)" in the text of a notification, and in what an input box asks or says
  // of an input, and runs a command such a link names when it is clicked. The host shows them through `notify`,
  // which breaks every such pair. A call that goes to VS Code past it is found here, not by a user.
  const folder = path.join(root, 'vscode-host');
  for (const name of fs.readdirSync(folder).filter(name => /\.[cm]?js$/.test(name))) {
    const source = fs.readFileSync(path.join(folder, name), 'utf8');
    // What `notify` itself is made of: the three names in one list, reached as vscode.window[name], and the one input box.
    const own = source.split('\n').filter(line => /^\s*for \(const name of \['showInformationMessage', 'showWarningMessage', 'showErrorMessage'\]\)$/.test(line)).length;
    const rest = source.replace(/^\s*for \(const name of \['showInformationMessage', 'showWarningMessage', 'showErrorMessage'\]\)$/m, '');
    for (const [, before] of rest.matchAll(/(.{0,12})show(?:Information|Warning|Error)Message/g)) assert.match(before, /notify\.$/, name + ': a notification is shown past notify (' + before + ')');
    assert.equal((source.match(/window\s*\[/g) || []).length, own ? 2 : 0, name + ': a function of the window is reached by a name that is worked out');
    assert.equal((source.match(/(?<!notify)\.showInputBox/g) || []).length, own ? 1 : 0, name + ': an input box is shown past notify');
    if (name === 'runtime-entry.cjs') assert.equal(own, 1, 'the place itself is there');
  }
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
