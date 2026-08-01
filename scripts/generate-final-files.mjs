#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed with exit code ${result.status}`);
}

run('scripts/apply-final-hardening.mjs');

const changelogPath = path.join(root, 'CHANGELOG.md');
const current = fs.readFileSync(changelogPath, 'utf8');
if (!current.includes('\n## 2.9.2\n')) {
  const header = `# Changelog

## 2.9.2

- Added a read-only release-version contract so CI fails instead of silently rewriting package, lockfile, extension, Gateway, CLI, smoke-test, and changelog versions.
- Added shared cross-process configuration locking, 16 MiB config bounds, 128 MiB durable-state bounds, and validated replacement recovery before cleanup or quarantine.
- Made external Job selection and Runner Claim fencing one durable-document transaction, eliminating the crash window between Job ownership and proof issuance.
- Bounded in-memory metric cardinality, normalized per-Job Runner routes, and exposed dropped-series counters.
- Bounded local and published preview servers/sessions, restricted static proxies to GET/HEAD, added upstream timeouts, and made malformed cookie/path encoding non-fatal.
- Added deterministic preview shutdown, connection limits, and per-workspace/global capacity controls without changing public tool inputs.
- Added regression coverage for version drift, config locks and size limits, atomic external claims, metric series pressure, preview capacity, malformed cookies, and resource cleanup.

## 2.9.1

- Added configuration conflict detection, retryable mutations, atomic replacement recovery, recursive audit redaction, fixed-window rate-map bounds, external Runner claim fencing, and Job-store capacity limits.
- Added Windows and Linux full repository/test/Gateway verification while preserving existing public MCP and Godot workflows.

`;
  if (!current.startsWith('# Changelog\n')) throw new Error('Unexpected CHANGELOG header');
  fs.writeFileSync(changelogPath, header + current.slice('# Changelog\n\n'.length), 'utf8');
}

run('scripts/sync-version.mjs');
console.log('Generated final DevMate 2.9.2 source files.');
