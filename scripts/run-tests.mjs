#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import processTree from '../runtime/platform/process-tree.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = path.join(root, 'tests');
const args = new Set(process.argv.slice(2));
const realOnly = args.has('--real');
const includeReal = realOnly || args.has('--include-real');
const batchSizeArg = process.argv.find(value => value.startsWith('--batch-size='));
const batchTimeoutArg = process.argv.find(value => value.startsWith('--batch-timeout-ms='));
const diagnosticTimeoutArg = process.argv.find(value => value.startsWith('--diagnostic-timeout-ms='));
const batchSize = Math.min(100, Math.max(1, Number(batchSizeArg?.split('=')[1]) || 24));
const batchTimeoutMs = Math.min(10 * 60_000, Math.max(30_000, Number(batchTimeoutArg?.split('=')[1]) || 180_000));
const diagnosticTimeoutMs = Math.min(5 * 60_000, Math.max(10_000, Number(diagnosticTimeoutArg?.split('=')[1]) || 45_000));
// Test files that must not share a process batch with others.
const SERIAL_TEST_FILES = new Set();

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

// The temp directory is often reached through a link or an alias (/var on macOS, a short name on Windows).
// Tests compare paths they created with paths a child process reports, so they are given the real one.
const realTemp = (() => { try { return fs.realpathSync.native(os.tmpdir()); } catch { return os.tmpdir(); } })();
const testEnvironment = { ...process.env, ...(process.platform === 'win32' ? { TEMP: realTemp, TMP: realTemp } : { TMPDIR: realTemp }) };

// A run that is stopped (by its timeout or by the person at the terminal) is stopped together with
// everything it started, so that no test process is left behind holding a port or a file.
let running = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    if (running) await processTree.terminateProcessTree(running).catch(() => {});
    process.exit(130);
  });
}

function run(files, stdio = 'inherit', timeoutMs = batchTimeoutMs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--test', ...files], {
      cwd: root,
      env: testEnvironment,
      stdio: ['ignore', stdio, stdio],
      windowsHide: true,
      // Its own process group where groups exist, so the whole group can be signalled.
      detached: process.platform !== 'win32'
    });
    running = child;
    let stdout = '';
    let stderr = '';
    let error;
    child.stdout?.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      error = Object.assign(new Error(`Timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' });
      processTree.terminateProcessTree(child).catch(() => {});
    }, timeoutMs);
    const settle = (status, failure) => {
      clearTimeout(timer);
      if (running === child) running = null;
      resolve({ status, stdout, stderr, error: error || failure });
    };
    child.once('error', failure => settle(null, failure));
    child.once('close', status => settle(status));
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
    const message = `Isolated test file timed out after ${diagnosticTimeoutMs}ms, the cause is unconfirmed. Inspect phase timings, slow operations, and open runtime handles.`;
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

async function diagnoseBatch(batch) {
  const failures = [];
  console.error(`Batch failed; isolating ${batch.length} test files...`);
  for (const file of batch) {
    const result = await run([file], 'pipe', diagnosticTimeoutMs);
    if (!timedOut(result) && result.error) throw result.error;
    if (!timedOut(result) && result.status === 0) continue;
    failures.push(reportIsolatedFailure(file, result));
  }
  if (!failures.length) {
    const message = batch.length === 1
      ? 'The test file failed initially but passed on retry. The failure is intermittent; its cause is unconfirmed.'
      : 'The failed test batch passed file-by-file. The failure was not reproduced; concurrency is only one possible cause.';
    console.error(message);
    githubError('.github', message);
  } else {
    console.error(`\nFailing test files: ${failures.join(', ')}`);
  }
  return failures;
}

async function diagnoseTimedOutGroup(group) {
  if (group.length === 1) {
    const result = await run(group, 'pipe', diagnosticTimeoutMs);
    if (!timedOut(result) && result.error) throw result.error;
    if (!timedOut(result) && result.status === 0) {
      const rel = relative(group[0]);
      const message = 'Test file passed on retry after a timeout. The timeout was not reproduced; its cause is unconfirmed.';
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
    const result = await run(half, 'pipe', diagnosticTimeoutMs);
    if (timedOut(result)) {
      console.error(`Timed-out subgroup (${half.length} files): ${half.map(relative).join(', ')}`);
      failures.push(...await diagnoseTimedOutGroup(half));
      continue;
    }
    if (result.error) throw result.error;
    if (result.status !== 0) failures.push(...await diagnoseBatch(half));
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
  const result = await run(batch);
  if (timedOut(result)) {
    console.error(`Batch timed out after ${batchTimeoutMs}ms; bisecting ${batch.length} test files...`);
    const failures = await diagnoseTimedOutGroup(batch);
    if (!failures.length) githubError('.github', 'A test batch timed out but diagnostic reruns did not reproduce a failure. Inspect original output and phase timings; the cause is unconfirmed.');
    process.exit(1);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    await diagnoseBatch(batch);
    process.exit(result.status || 1);
  }
}

console.log(`Passed ${files.length} discovered test files.`);

export const __test = { annotationEscape, failureNames };
