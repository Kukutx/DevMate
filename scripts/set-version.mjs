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
const stated = /^(\s*"version": ")[^"]*(")/gm;
rewrite('package.json', stated, 1);
// The lock file states it for the project and again for its root package.
rewrite('package-lock.json', stated, 2);
rewrite('plugin.json', stated, 1);
rewrite('manifest.json', stated, 1);
rewrite('runtime/version.mjs', /^(export const VERSION = ')[^']*(')/m, 1);
// Obsidian reads here which release fits which version of the app.
const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));
versions[version] = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).minAppVersion;
fs.writeFileSync(path.join(root, 'versions.json'), JSON.stringify(versions, null, 2) + '\n');
console.log('Version ' + version + ' is stated everywhere. Add a "## ' + version + '" section to CHANGELOG.md, then run npm run check.');
