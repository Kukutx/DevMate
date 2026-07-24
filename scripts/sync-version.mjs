#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(root, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const version = String(packageJson.version || '').trim();

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid package version: ${version || '(empty)'}`);
}

function replaceRequired(relativePath, replacements) {
  const fullPath = path.join(root, relativePath);
  let content = fs.readFileSync(fullPath, 'utf8');
  let changed = false;

  for (const { pattern, replacement, label } of replacements) {
    const next = content.replace(pattern, replacement);
    if (next === content && !content.includes(replacement)) {
      throw new Error(`Could not synchronize ${label || relativePath} in ${relativePath}`);
    }
    if (next !== content) changed = true;
    content = next;
  }

  if (changed) {
    fs.writeFileSync(fullPath, content, 'utf8');
    console.log(`Synchronized ${relativePath} -> ${version}`);
  }
}

replaceRequired('extension.js', [
  {
    pattern: /const VERSION = '[^']+';/,
    replacement: `const VERSION = '${version}';`,
    label: 'extension runtime version'
  }
]);

replaceRequired('gateway/server.mjs', [
  {
    pattern: /const VERSION = '[^']+';/,
    replacement: `const VERSION = '${version}';`,
    label: 'gateway runtime version'
  }
]);

replaceRequired('tests/smoke-gateway.mjs', [
  {
    pattern: /appVersion: '[^']+',/,
    replacement: `appVersion: '${version}',`,
    label: 'smoke config version'
  },
  {
    pattern: /clientInfo: \{ name: 'devmate-smoke', version: '[^']+' \}/,
    replacement: `clientInfo: { name: 'devmate-smoke', version: '${version}' }`,
    label: 'smoke client version'
  }
]);

replaceRequired('tests/smoke-local-capabilities.mjs', [
  {
    pattern: /appVersion: '[^']+',/,
    replacement: `appVersion: '${version}',`,
    label: 'local smoke config version'
  },
  {
    pattern: /clientInfo: \{ name: 'devmate-local-smoke', version: '[^']+' \}/,
    replacement: `clientInfo: { name: 'devmate-local-smoke', version: '${version}' }`,
    label: 'local smoke client version'
  }
]);

const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  let changed = false;
  if (lock.version !== version) {
    lock.version = version;
    changed = true;
  }
  if (lock.packages?.['']?.version !== version) {
    lock.packages[''].version = version;
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
    console.log(`Synchronized package-lock.json -> ${version}`);
  }
}
