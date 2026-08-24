'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'gateway', 'team-capabilities.mjs'), 'utf8');

function authorizationBlock() {
  const start = source.indexOf('export function wrapAuthorizedTool');
  const end = source.indexOf('export function installTeamCapabilities', start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

test('approved execution is consumed only after the workspace lease hold is acquired', () => {
  const block = authorizationBlock();
  const hold = block.indexOf('leaseHold = acquireWorkspaceLeaseHold');
  const approval = block.indexOf('const approval = ensureToolApproval');
  const handler = block.indexOf('runWithWorkSessionContext');
  assert.ok(hold >= 0, 'authorized execution must hold the workspace lease');
  assert.ok(approval > hold, 'approval must not be consumed before the lease hold succeeds');
  assert.ok(handler > approval, 'approval must be consumed immediately before entering the tool handler');
});

test('approval and handler paths both release an acquired lease hold without making cleanup failure an ambiguous tool retry', () => {
  const block = authorizationBlock();
  assert.match(block, /const releaseLeaseHoldSafely = async stage =>/);
  assert.match(block, /catch \(cleanupError\) \{[\s\S]*workspace_lease_hold_release_failed/);
  assert.match(block, /finally \{\s*await releaseLeaseHoldSafely\('post-handler'\);\s*\}/);
  assert.match(block, /catch \(error\) \{\s*await releaseLeaseHoldSafely\('error-path'\);/);
  assert.doesNotMatch(block, /throw cleanupError/);
});
