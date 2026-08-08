#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = path.join(root, 'tests');
const args = new Set(process.argv.slice(2));
const realOnly = args.has('--real');
const includeReal = realOnly || args.has('--include-real');
const batchSizeArg = process.argv.find(value => value.startsWith('--batch-size='));
const batchSize = Math.min(100, Math.max(1, Number(batchSizeArg?.split('=')[1]) || 24));

function relative(file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function discover(directory = testsRoot, output = []) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      discover(full, output);
      continue;
    }
    if (!entry.isFile() || !/\.test\.(?:mjs|cjs|js)$/i.test(entry.name)) continue;
    const isReal = /^godot-real-/i.test(entry.name);
    if (realOnly ? !isReal : (!includeReal && isReal)) continue;
    output.push(full);
  }
  return output;
}

function run(files, stdio = 'inherit') {
  return spawnSync(process.execPath, ['--test', ...files], {
    cwd: root,
    env: process.env,
    stdio,
    windowsHide: true,
    encoding: stdio === 'pipe' ? 'utf8' : undefined
  });
}

function diagnoseBatch(batch) {
  const failures = [];
  console.error(`Batch failed; isolating ${batch.length} test files...`);
  for (const file of batch) {
    const result = run([file], 'pipe');
    if (result.error) throw result.error;
    if (result.status === 0) continue;
    failures.push(relative(file));
    console.error(`\nFAIL: ${relative(file)}`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (!failures.length) {
    console.error('The batch failure was not reproducible file-by-file; this indicates an inter-test or concurrency interaction.');
  } else {
    console.error(`\nFailing test files: ${failures.join(', ')}`);
  }
  return failures;
}

const files = discover();
if (!files.length) {
  console.error('No matching test files were discovered.');
  process.exit(1);
}

for (let index = 0; index < files.length; index += batchSize) {
  const batch = files.slice(index, index + batchSize);
  console.log(`Running test batch ${Math.floor(index / batchSize) + 1}: ${batch.map(relative).join(', ')}`);
  const result = run(batch);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    diagnoseBatch(batch);
    process.exit(result.status || 1);
  }
}

console.log(`Passed ${files.length} discovered test files.`);