#!/usr/bin/env node
// States one new version in every file that carries it. `npm run check` proves afterwards
// that they agree and that the changelog has a section for it.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const version = process.argv[2] || '';
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Usage: npm run version:set -- <major.minor.patch>');

function rewrite(file, pattern, expected) {
  const full = path.join(root, file);
  let seen = 0;
  const text = fs.readFileSync(full, 'utf8').replace(pattern, (all, before, after) => seen++ < expected ? before + version + after : all);
  if (seen < expected) throw new Error(file + ' does not state a version where one is expected.');
  fs.writeFileSync(full, text);
}
// What was written down for the next release since the last one is that release's section from now on. Left under
// "Unreleased" beside a new section, it would pass every check and be missing from the notes of the release. Looked
// at before anything is written.
const changelog = path.join(root, 'CHANGELOG.md'), lines = fs.readFileSync(changelog, 'utf8').split('\n');
const waiting = lines.findIndex(line => line.trim() === '## Unreleased'), named = lines.some(line => line.trim() === '## ' + version);
// A lower number than the one stated takes a version back that was set and not released. What setting it did is
// undone with it: its section waits for the next release again, and versions.json does not name a release that never
// was. Left as they were, the section would stay under a number nothing is released by, and the version that is
// released later would pass every check with an empty section of its own.
const before = /^export const VERSION = '(\d+\.\d+\.\d+)'/m.exec(fs.readFileSync(path.join(root, 'runtime/version.mjs'), 'utf8'))?.[1];
const order = (one, other) => { const [a, b] = [one, other].map(text => text.split('.').map(Number)); return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; };
const back = !!before && order(version, before) < 0, taken = back ? lines.findIndex(line => line.trim() === '## ' + before) : -1;
if (taken >= 0 && waiting >= 0) throw new Error('CHANGELOG.md has both "## Unreleased" and "## ' + before + '", the version that is taken back. Put what is under one into the other and remove its heading.');
if (!back && waiting >= 0 && named) throw new Error('CHANGELOG.md has both "## Unreleased" and "## ' + version + '". Put what is under Unreleased into the section of the version and remove that heading.');
const stated = /^(\s*"version": ")[^"]*(")/gm;
rewrite('package.json', stated, 1);
// The lock file states it for the project and again for its root package.
rewrite('package-lock.json', stated, 2);
rewrite('plugin.json', stated, 1);
rewrite('manifest.json', stated, 1);
// The browser extension. A runtime puts its own copy in the place of the one a browser loads unless that one states
// a later version: an extension left at the number before would be put back by every entry that is still older.
rewrite('chrome-extension/manifest.json', stated, 1);
rewrite('runtime/version.mjs', /^(export const VERSION = ')[^']*(')/m, 1);
// Obsidian reads here which release fits which version of the app.
const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));
versions[version] = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).minAppVersion;
if (back) delete versions[before];
fs.writeFileSync(path.join(root, 'versions.json'), JSON.stringify(versions, null, 2) + '\n');
if (!back && waiting >= 0) { lines[waiting] = lines[waiting].replace('## Unreleased', '## ' + version); fs.writeFileSync(changelog, lines.join('\n')); }
if (taken >= 0) { lines[taken] = lines[taken].replace('## ' + before, '## Unreleased'); fs.writeFileSync(changelog, lines.join('\n')); }
console.log('Version ' + version + ' is stated everywhere. ' + (back ? (taken >= 0 ? 'What was collected for ' + before + ' is under "## Unreleased" of CHANGELOG.md again, and versions.json' : 'versions.json') + ' no longer names ' + before
  : waiting >= 0 ? 'The "## Unreleased" section of CHANGELOG.md is now "## ' + version + '": read it once more as the notes of the release'
  : named ? 'CHANGELOG.md has its "## ' + version + '" section' : 'Add a "## ' + version + '" section to CHANGELOG.md') + '. Then run npm run check.');
