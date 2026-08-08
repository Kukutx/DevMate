import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-approvals-'));
const configPath = path.join(temp, 'config.json');
const config = {
  instanceId: 'approval-test',
  team: {
    members: [],
    approvals: {
      enabled: true,
      requiredCapabilities: ['publish', 'admin']
    }
  },
  permissions: { profile: 'fullAccess' }
};
await fsp.writeFile(configPath, JSON.stringify(config), 'utf8');
process.env.DEVMATE_CONFIG = configPath;

const approvals = await import('../gateway/approvals.mjs');

const alice = { id: 'alice', name: 'Alice', role: 'maintainer', source: 'team-token', workspaceIds: ['app'] };
const bob = { id: 'bob', name: 'Bob', role: 'maintainer', source: 'team-token', workspaceIds: ['app'] };
const call = {
  config,
  principal: alice,
  tool: 'git_push',
  capability: 'publish',
  workspaceId: 'app',
  args: { workspaceId: 'app', remote: 'origin', branch: 'main' }
};

test('approval policy is an explicit access capability and validates malformed values strictly', () => {
  assert.deepEqual(approvals.approvalPolicy(config), {
    enabled: true,
    requiredCapabilities: ['publish', 'admin'],
    requiredTools: [],
    ttlSeconds: 3600,
    separationOfDuties: true,
    ownerBypass: true
  });
  assert.equal(approvals.approvalPolicy({ team: { members: [] } }).enabled, false);
  assert.throws(() => approvals.approvalPolicy({ team: { approvals: { enabled: 'false' } } }), /must be a boolean/);
  assert.throws(() => approvals.approvalPolicy({ team: { approvals: { ttlSeconds: '300' } } }), /must be an integer/);
  assert.throws(() => approvals.approvalPolicy({ team: { approvals: { requiredCapabilities: ['publish', 'root'] } } }), /Invalid approval capability/);
  assert.throws(() => approvals.approvalPolicy({ team: { approvals: { ownerByPass: false } } }), /Unknown team\.approvals setting/);
});

test('requires a separate maintainer and consumes approval on exact retry', () => {
  let pending;
  assert.throws(() => approvals.ensureToolApproval(call), error => {
    pending = error.approvalRequest;
    return error.code === 'approval_required' && pending?.status === 'pending';
  });
  assert.ok(pending.id.startsWith('approval-'));
  assert.throws(() => approvals.decideApprovalRequest({ id: pending.id, principal: alice, decision: 'approve', config }), /different principal/);

  const approved = approvals.decideApprovalRequest({
    id: pending.id,
    principal: bob,
    decision: 'approve',
    note: 'Reviewed change',
    config
  });
  assert.equal(approved.status, 'approved');

  const permit = approvals.ensureToolApproval(call);
  assert.equal(permit.approved, true);
  assert.equal(permit.request.status, 'consumed');
  assert.throws(() => approvals.ensureToolApproval(call), error => error.code === 'approval_required');
});

test('redacts sensitive arguments in approval summaries', () => {
  let request;
  assert.throws(() => approvals.ensureToolApproval({
    ...call,
    tool: 'plugin_configure',
    capability: 'admin',
    args: { id: 'example', settings: { apiToken: 'secret-value', endpoint: 'https://example.test?token=abc' } }
  }), error => {
    request = error.approvalRequest;
    return error.code === 'approval_required';
  });
  assert.equal(request.argumentSummary.settings.apiToken, 'redacted');
  assert.doesNotMatch(JSON.stringify(request.argumentSummary), /secret-value|token=abc/);
});

test.after(async () => {
  approvals.clearApprovalRequests();
  await fsp.rm(temp, { recursive: true, force: true });
});
