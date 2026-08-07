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
  }
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`\nSyntax check failed: ${failure.file}\n${failure.output}`);
  }
  console.error(`\n${failures.length} of ${files.length} JavaScript files failed syntax checks.`);
  process.exit(1);
}

const forbidden = [
  ['gateway/server.mjs', /writeFileSync\(CONFIG_PATH/, 'direct Gateway config write'],
  ['extension.js', /permissionProfile\(\) === 'fullAccess' \|\| .*allowDirectoryMutations/, 'directory permission bypass'],
  ['extension-entry-platform.js', /extension-config-io|extension-entry-win32/, 'removed compatibility entry'],
  ['gateway/team-tool-data.mjs', /map\.set\(item\.name/, 'ambiguous workspace scope map']
];
for (const [file, pattern, label] of forbidden) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  if (pattern.test(source)) failures.push({ file, output: label });
}
for (const removed of ['extension-config-io.js', 'extension-entry-win32.js', 'ngrok-launch-compat.js', 'host/runtime/config-store.js']) {
  if (fs.existsSync(path.join(root, removed))) failures.push({ file: removed, output: 'removed architecture file still exists' });
}
if (failures.length) {
  for (const failure of failures) console.error(`\nRepository contract failed: ${failure.file}\n${failure.output}`);
  process.exit(1);
}
console.log(`Checked ${files.length} JavaScript files and architecture contracts.`);
