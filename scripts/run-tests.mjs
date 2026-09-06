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
const batchTimeoutArg = process.argv.find(value => value.startsWith('--batch-timeout-ms='));
const diagnosticTimeoutArg = process.argv.find(value => value.startsWith('--diagnostic-timeout-ms='));
const batchSize = Math.min(100, Math.max(1, Number(batchSizeArg?.split('=')[1]) || 24));
const batchTimeoutMs = Math.min(10 * 60_000, Math.max(30_000, Number(batchTimeoutArg?.split('=')[1]) || 90_000));
const diagnosticTimeoutMs = Math.min(5 * 60_000, Math.max(10_000, Number(diagnosticTimeoutArg?.split('=')[1]) || 45_000));
const SERIAL_TEST_FILES = new Set([
  'tests/gateway-large-state-startup.test.mjs'
]);

function relative(file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function annotationEscape(value) {
  return String(value || '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function githubError(file, message) {
  if (!process.env.GITHUB_ACTIONS) return;
  console.error(`::error file=${annotationEscape(file)}::${annotationEscape(message)}`);
}

function failureNames(output) {
  const names = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*[✖✗]\s+(.+?)(?:\s+\([\d.]+ms\))?\s*$/u);
    if (!match) continue;
    const name = match[1].trim();
    if (name && !names.includes(name)) names.push(name);
    if (names.length >= 5) break;
  }
  return names;
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

function testBatches(files, maxBatchSize = batchSize) {
  const batches = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    batches.push(current);
    current = [];
  };
  for (const file of files) {
    if (SERIAL_TEST_FILES.has(relative(file))) {
      flush();
      batches.push([file]);
      continue;
    }
    current.push(file);
    if (current.length >= maxBatchSize) flush();
  }
  flush();
  return batches;
}

function run(files, stdio = 'inherit', timeoutMs = batchTimeoutMs) {
  return spawnSync(process.execPath, ['--test', ...files], {
    cwd: root,
    env: process.env,
    stdio,
    windowsHide: true,
    encoding: stdio === 'pipe' ? 'utf8' : undefined,
    timeout: timeoutMs,
    killSignal: 'SIGKILL'
  });
}

function timedOut(result) {
  return result?.error?.code === 'ETIMEDOUT';
}

function printCaptured(result) {
  if (result?.stdout) process.stderr.write(result.stdout);
  if (result?.stderr) process.stderr.write(result.stderr);
}

function reportIsolatedFailure(file, result) {
  const rel = relative(file);
  console.error(`\nFAIL: ${rel}`);
  printCaptured(result);
  if (timedOut(result)) {
    const message = `Isolated test file timed out after ${diagnosticTimeoutMs}ms, indicating a leaked/open runtime handle or an unbounded operation.`;
    console.error(message);
    githubError(rel, message);
    return rel;
  }
  if (result?.error) throw result.error;
  const names = failureNames(`${result.stdout || ''}\n${result.stderr || ''}`);
  const detail = names.length ? ` Failing test(s): ${names.join('; ')}.` : '';
  githubError(rel, `Isolated test file failed with exit code ${result.status || 1}.${detail} See the Discovered unit and policy tests step for details.`);
  return rel;
}

function diagnoseBatch(batch) {
  const failures = [];
  console.error(`Batch failed; isolating ${batch.length} test files...`);
  for (const file of batch) {
    const result = run([file], 'pipe', diagnosticTimeoutMs);
    if (!timedOut(result) && result.error) throw result.error;
    if (!timedOut(result) && result.status === 0) continue;
    failures.push(reportIsolatedFailure(file, result));
  }
  if (!failures.length) {
    const message = 'The failed test batch passed file-by-file, indicating an inter-test or concurrency interaction.';
    console.error(message);
    githubError('.github', message);
  } else {
    console.error(`\nFailing test files: ${failures.join(', ')}`);
  }
  return failures;
}

function diagnoseTimedOutGroup(group) {
  if (group.length === 1) {
    const result = run(group, 'pipe', diagnosticTimeoutMs);
    if (!timedOut(result) && result.error) throw result.error;
    if (!timedOut(result) && result.status === 0) {
      const rel = relative(group[0]);
      const message = 'Test file passed in isolation after its batch timed out, indicating an inter-test or concurrency interaction.';
      console.error(`${rel}: ${message}`);
      githubError(rel, message);
      return [];
    }
    return [reportIsolatedFailure(group[0], result)];
  }

  const midpoint = Math.ceil(group.length / 2);
  const halves = [group.slice(0, midpoint), group.slice(midpoint)].filter(part => part.length);
  const failures = [];
  for (const half of halves) {
    const result = run(half, 'pipe', diagnosticTimeoutMs);
    if (timedOut(result)) {
      console.error(`Timed-out subgroup (${half.length} files): ${half.map(relative).join(', ')}`);
      failures.push(...diagnoseTimedOutGroup(half));
      continue;
    }
    if (result.error) throw result.error;
    if (result.status !== 0) failures.push(...diagnoseBatch(half));
  }
  return failures;
}

const files = discover();
if (!files.length) {
  console.error('No matching test files were discovered.');
  process.exit(1);
}

const batches = testBatches(files);
for (let index = 0; index < batches.length; index += 1) {
  const batch = batches[index];
  console.log(`Running test batch ${index + 1}: ${batch.map(relative).join(', ')}`);
  const result = run(batch);
  if (timedOut(result)) {
    console.error(`Batch timed out after ${batchTimeoutMs}ms; bisecting ${batch.length} test files...`);
    const failures = diagnoseTimedOutGroup(batch);
    if (!failures.length) githubError('.github', 'A test batch timed out but no single-file failure was reproduced; investigate inter-test resource leakage.');
    process.exit(1);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    diagnoseBatch(batch);
    process.exit(result.status || 1);
  }
}

console.log(`Passed ${files.length} discovered test files.`);

export const __test = { annotationEscape, failureNames };
