#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const packagePath = path.join(root, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const version = String(packageJson.version || '').trim();

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`package.json contains an invalid semantic version: ${version || '(empty)'}`);
}

const drift = [];

function syncJson(relativePath, desired, description) {
  const file = path.join(root, relativePath);
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (JSON.stringify(current) === JSON.stringify(desired)) return;
  if (checkOnly) drift.push(`${relativePath}: ${description}`);
  else fs.writeFileSync(file, `${JSON.stringify(desired, null, 2)}\n`, 'utf8');
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'obsidian-plugin', 'manifest.json'), 'utf8'));
manifest.version = version;
syncJson('obsidian-plugin/manifest.json', manifest, 'Obsidian manifest version');
syncJson('manifest.json', manifest, 'Obsidian Community Plugins manifest mirror');

const pluginPackage = JSON.parse(fs.readFileSync(path.join(root, 'obsidian-plugin', 'package.json'), 'utf8'));
pluginPackage.version = version;
syncJson('obsidian-plugin/package.json', pluginPackage, 'Obsidian package version');

const versions = JSON.parse(fs.readFileSync(path.join(root, 'obsidian-plugin', 'versions.json'), 'utf8'));
versions[version] = manifest.minAppVersion;
syncJson('obsidian-plugin/versions.json', versions, 'Obsidian version compatibility');
syncJson('versions.json', versions, 'Obsidian Community Plugins compatibility mirror');

const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
lock.version = version;
lock.packages ||= {};
lock.packages[''] ||= {};
lock.packages[''].version = version;
syncJson('package-lock.json', lock, 'package-lock root versions');

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const firstRelease = changelog.match(/^##\s+([^\s]+)\s*$/m)?.[1] || '';
if (firstRelease !== version) {
  const issue = `CHANGELOG.md: first release is ${firstRelease || '(missing)'}, expected ${version}`;
  if (checkOnly) drift.push(issue);
  else throw new Error(issue);
}

if (drift.length) {
  process.stderr.write(`Version contract failed for ${version}:\n- ${drift.join('\n- ')}\nRun npm run version:sync and commit the resulting files.\n`);
  process.exit(1);
}

process.stdout.write(`${checkOnly ? 'Verified' : 'Synchronized'} DevMate version ${version}.\n`);
