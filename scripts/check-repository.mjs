#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensions = new Set(['.js', '.mjs', '.cjs']);
const ignoredDirectories = new Set([
  '.git', '.godot-ci', '.vscode-test', 'build', 'coverage', 'dist', 'node_modules', 'out'
]);
const ignoredFiles = new Set([
  'gateway/server.bundle.mjs'
]);

function relative(file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function discover(directory = root, output = []) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      discover(full, output);
      continue;
    }
    if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
    if (ignoredFiles.has(relative(full))) continue;
    output.push(full);
  }
  return output;
}

function localModuleSpecifiers(source) {
  const found = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  const seen = new Set();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier?.startsWith('.')) continue;
      const key = `${match.index}:${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ specifier, index: match.index || 0 });
    }
  }
  return found;
}

function localModuleExists(file, specifier) {
  const resolved = path.resolve(path.dirname(file), specifier);
  const candidates = path.extname(resolved)
    ? [resolved]
    : [
      resolved,
      `${resolved}.js`, `${resolved}.mjs`, `${resolved}.cjs`, `${resolved}.json`,
      path.join(resolved, 'index.js'), path.join(resolved, 'index.mjs'),
      path.join(resolved, 'index.cjs'), path.join(resolved, 'index.json')
    ];
  return candidates.some(candidate => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
}

const files = discover();
const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    failures.push({
      file: relative(file),
      output: `${result.stdout || ''}${result.stderr || ''}`.trim()
    });
    continue;
  }

  const source = fs.readFileSync(file, 'utf8');
  for (const entry of localModuleSpecifiers(source)) {
    if (localModuleExists(file, entry.specifier)) continue;
    const line = source.slice(0, entry.index).split(/\r?\n/).length;
    failures.push({
      file: relative(file),
      output: `missing local module ${entry.specifier} at line ${line}`
    });
  }
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`\nRepository source check failed: ${failure.file}\n${failure.output}`);
  }
  console.error(`\n${failures.length} source checks failed across ${files.length} JavaScript files.`);
  process.exit(1);
}

const forbidden = [
  ['gateway/server.mjs', /writeFileSync\(CONFIG_PATH/, 'direct Gateway config write'],
  ['extension.js', /permissionProfile\(\) === 'fullAccess' \|\| .*allowDirectoryMutations/, 'directory permission bypass'],
  ['gateway/team-tool-data.mjs', /map\.set\(item\.name/, 'ambiguous workspace scope map']
];
for (const [file, pattern, label] of forbidden) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  if (pattern.test(source)) failures.push({ file, output: label });
}
if (failures.length) {
  for (const failure of failures) console.error(`\nRepository contract failed: ${failure.file}\n${failure.output}`);
  process.exit(1);
}
console.log(`Checked ${files.length} JavaScript files, local module targets, and current architecture contracts.`);
