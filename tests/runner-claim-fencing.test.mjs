import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-runner-claims-'));
const configPath = path.join(root, 'config.json');
await fsp.writeFile(configPath, JSON.stringify({
  instanceId: 'runner-claim-tests',
  permissions: { profile: 'fullAccess' }
}), 'utf8');
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const durable = await import('../gateway/durable-state.mjs');
const claims = await import('../gateway/runner-claim-fencing.mjs');

test.beforeEach(() => {
  durable.resetDurableStateForTests();
  claims.clearRunnerClaimsForTests();
});

test('stores only a hash and accepts the active claim proof', () => {
  const issued = claims.issueRunnerClaim({
    jobId: 'job-1',
    runnerId: 'runner-a',
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString()
  });
  assert.equal(issued.generation, 1);
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(claims.validateRunnerClaim({
    jobId: 'job-1',
    runnerId: 'runner-a',
    generation: issued.generation,
    token: issued.token
  }).generation, 1);
  const stored = durable.readDurableNamespace('runner-claims', null);
  assert.equal(stored.claims['job-1'].token, undefined);
  assert.notEqual(stored.claims['job-1'].tokenHash, issued.token);
  assert.equal(stored.generations['job-1'].generation, 1);
});

test('rejects a stale proof after the same job is reissued', () => {
  const first = claims.issueRunnerClaim({
    jobId: 'job-replayed',
    runnerId: 'runner-a',
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString()
  });
  const second = claims.issueRunnerClaim({
    jobId: 'job-replayed',
    runnerId: 'runner-a',
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString()
  });
  assert.equal(second.generation, 2);
  assert.throws(() => claims.validateRunnerClaim({
    jobId: 'job-replayed',
    runnerId: 'runner-a',
    generation: first.generation,
    token: first.token
  }), error => {
    assert.equal(error.status, 409);
    assert.match(error.message, /stale/);
    return true;
  });
  assert.throws(() => claims.validateRunnerClaim({
    jobId: 'job-replayed',
    runnerId: 'runner-a',
    allowLegacyFirst: true
  }), /stale/);
  assert.equal(claims.validateRunnerClaim({
    jobId: 'job-replayed',
    runnerId: 'runner-a',
    generation: second.generation,
    token: second.token
  }).generation, 2);
});

test('allows legacy proof omission only for the first claim generation', () => {
  claims.issueRunnerClaim({
    jobId: 'job-legacy',
    runnerId: 'runner-a',
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString()
  });
  assert.equal(claims.validateRunnerClaim({
    jobId: 'job-legacy',
    runnerId: 'runner-a',
    allowLegacyFirst: true
  }).generation, 1);
  claims.issueRunnerClaim({
    jobId: 'job-legacy',
    runnerId: 'runner-a',
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString()
  });
  assert.throws(() => claims.validateRunnerClaim({
    jobId: 'job-legacy',
    runnerId: 'runner-a',
    allowLegacyFirst: true
  }), /stale/);
});

test('retains the generation watermark after a claim is consumed', () => {
  const first = claims.issueRunnerClaim({
    jobId: 'job-consumed',
    runnerId: 'runner-a',
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString()
  });
  claims.consumeRunnerClaim({
    jobId: 'job-consumed',
    runnerId: 'runner-a',
    generation: first.generation,
    token: first.token
  });
  const second = claims.issueRunnerClaim({
    jobId: 'job-consumed',
    runnerId: 'runner-a',
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString()
  });
  assert.equal(second.generation, 2);
  assert.throws(() => claims.validateRunnerClaim({
    jobId: 'job-consumed',
    runnerId: 'runner-a',
    allowLegacyFirst: true
  }), /stale/);
});

test('renews and consumes a claim without exposing its token in status', () => {
  const issued = claims.issueRunnerClaim({
    jobId: 'job-renew',
    runnerId: 'runner-a',
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString()
  });
  const nextLease = new Date(Date.now() + 120000).toISOString();
  const renewed = claims.renewRunnerClaim({
    jobId: 'job-renew',
    runnerId: 'runner-a',
    generation: issued.generation,
    token: issued.token,
    leaseExpiresAt: nextLease
  });
  assert.equal(renewed.leaseExpiresAt, nextLease);
  const status = claims.runnerClaimStatus();
  assert.equal(status.active[0].token, undefined);
  claims.consumeRunnerClaim({
    jobId: 'job-renew',
    runnerId: 'runner-a',
    generation: issued.generation,
    token: issued.token
  });
  assert.equal(claims.runnerClaimStatus().active.length, 0);
  assert.equal(claims.runnerClaimStatus().retainedGenerations, 1);
});

test.after(async () => fsp.rm(root, { recursive: true, force: true }));
