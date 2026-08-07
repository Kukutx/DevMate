import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../gateway/job-tools.mjs';

const job = {
  id: 'job-1',
  workspaceId: 'workspace-b',
  requestedBy: { id: 'developer-b', name: 'Developer B' }
};

test('scoped maintainers cannot access jobs outside their workspace scope', () => {
  assert.throws(
    () => __test.ensureVisible(job, {
      id: 'maintainer-a',
      role: 'maintainer',
      workspaceIds: ['workspace-a']
    }),
    /not allowed to access job workspace workspace-b/
  );
});

test('maintainers may manage another principal job only inside their scope', () => {
  assert.equal(
    __test.ensureVisible(job, {
      id: 'maintainer-b',
      role: 'maintainer',
      workspaceIds: ['workspace-b']
    }),
    job
  );
});

test('owners with global scope can access any job', () => {
  assert.equal(
    __test.ensureVisible(job, {
      id: 'personal-owner',
      role: 'owner',
      workspaceIds: []
    }),
    job
  );
});
