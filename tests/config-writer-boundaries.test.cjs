'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', 'tests', 'dist', 'build', 'coverage', '.cache', 'tmp'
]);
const SKIP_FILES = new Set(['gateway/server.bundle.mjs']);
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);

function productionSources(directory = root, relativeBase = '') {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const relative = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionSources(full, relative));
      continue;
    }
    if (entry.isFile() && !SKIP_FILES.has(relative) && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push({ relative, full });
    }
  }
  return files;
}

function offenders(pattern, { allow = [] } = {}) {
  const allowed = new Set(allow);
  return productionSources()
    .filter(({ relative, full }) => !allowed.has(relative) && pattern.test(fs.readFileSync(full, 'utf8')))
    .map(({ relative }) => relative)
    .sort();
}

test('live production config writers cannot bypass the locked config store with atomicWriteJson', () => {
  assert.deepEqual(
    offenders(/\batomicWriteJson\b/, { allow: ['shared/config-store.cjs'] }),
    [],
    'atomicWriteJson is an internal persistence primitive; live production writers must use updateConfig/replaceConfig'
  );
});

test('lifecycle desired state has one authoritative production writer', () => {
  assert.deepEqual(
    offenders(/\.lifecycle\.desiredState\s*=(?!=)/, { allow: ['shared/lifecycle-intent.cjs'] }),
    [],
    'lifecycle.desiredState must be written through setLifecycleIntent so recovery tokens and generation fencing stay coherent'
  );
});

test('authentication mode has one authoritative policy writer', () => {
  assert.deepEqual(
    offenders(/\.auth\.mode\s*=(?!=)/, { allow: ['shared/auth-config.cjs'] }),
    [],
    'auth.mode must be written through configureAuthentication; config-store invariants are defense-in-depth, not the primary API'
  );
});
