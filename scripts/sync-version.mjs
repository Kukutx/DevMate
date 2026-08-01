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

function updateText(relativePath, pattern, replacement, description) {
  const file = path.join(root, relativePath);
  const current = fs.readFileSync(file, 'utf8');
  if (!pattern.test(current)) throw new Error(`Could not locate ${description} in ${relativePath}`);
  pattern.lastIndex = 0;
  const next = current.replace(pattern, replacement);
  if (next === current) return;
  if (checkOnly) drift.push(`${relativePath}: ${description}`);
  else fs.writeFileSync(file, next, 'utf8');
}

function updateJson(relativePath, mutate, description) {
  const file = path.join(root, relativePath);
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const before = JSON.stringify(current);
  mutate(current);
  if (JSON.stringify(current) === before) return;
  if (checkOnly) drift.push(`${relativePath}: ${description}`);
  else fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}

updateText('extension.js', /const VERSION = '[^']+';/, `const VERSION = '${version}';`, 'extension runtime version');
updateText('gateway/server.mjs', /const VERSION = '[^']+';/, `const VERSION = '${version}';`, 'Gateway runtime version');
updateText('scripts/devmate-command.mjs', /config\.appVersion = '[^']+';/, `config.appVersion = '${version}';`, 'bootstrap config version');
updateText('tests/smoke-gateway.mjs', /appVersion: '[^']+',/, `appVersion: '${version}',`, 'Gateway smoke version');
updateText('tests/smoke-local-capabilities.mjs', /appVersion: '[^']+',/, `appVersion: '${version}',`, 'local smoke version');

updateJson('package-lock.json', lock => {
  lock.version = version;
  lock.packages ||= {};
  lock.packages[''] ||= {};
  lock.packages[''].version = version;
}, 'package-lock root versions');

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
