'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'gateway', 'team-capabilities.mjs'), 'utf8');

test('approved execution is consumed only after the workspace lease hold is acquired', () => {
  const start = source.indexOf('export function wrapAuthorizedTool');
  const end = source.indexOf('export function installTeamCapabilities', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  const hold = block.indexOf('leaseHold = acquireWorkspaceLeaseHold');
  const approval = block.indexOf('const approval = ensureToolApproval');
  const handler = block.indexOf('runWithWorkSessionContext');
  assert.ok(hold >= 0, 'authorized execution must hold the workspace lease');
  assert.ok(approval > hold, 'approval must not be consumed before the lease hold succeeds');
  assert.ok(handler > approval, 'approval must be consumed immediately before entering the tool handler');
});

test('approval failure releases an already-acquired lease hold through the common error path', () => {
  const start = source.indexOf('export function wrapAuthorizedTool');
  const end = source.indexOf('export function installTeamCapabilities', start);
  const block = source.slice(start, end);
  assert.match(block, /catch \(error\) \{[\s\S]*if \(leaseHold\)[\s\S]*releaseWorkspaceLeaseHold/);
});
