import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_GENERATED_CREDENTIAL_ID,
  normalizeCredentialId,
  uniqueCredentialId
} from '../gateway/credential-id.mjs';
import { createTeamMember, verifyAccessToken } from '../gateway/team-access.mjs';
import { createRunnerCredential, verifyRunnerToken } from '../gateway/runner-access.mjs';

test('credential IDs are normalized, bounded, and suffix-safe', () => {
  assert.equal(normalizeCredentialId('  Hello World  '), 'hello-world');
  const long = normalizeCredentialId('x'.repeat(300));
  assert.equal(long.length, MAX_GENERATED_CREDENTIAL_ID);
  const second = uniqueCredentialId(new Set([long]), 'x'.repeat(300));
  assert.equal(second.length <= MAX_GENERATED_CREDENTIAL_ID, true);
  assert.match(second, /-2$/);
  assert.notEqual(second, long);
});

test('long and duplicate Team member names always produce immediately usable tokens', () => {
  const config = {
    auth: { required: true, token: 'owner-token' },
    deployment: { mode: 'team', tunnelProvider: 'external' },
    team: { members: [] },
    runtime: {},
    jobs: {},
    production: {}
  };
  const name = 'Very Long Team Member '.repeat(20);
  const first = createTeamMember(config, { name, workspaceIds: ['app'] });
  const second = createTeamMember(config, { name, workspaceIds: ['app'] });
  assert.ok(first.member.id.length <= MAX_GENERATED_CREDENTIAL_ID);
  assert.ok(second.member.id.length <= MAX_GENERATED_CREDENTIAL_ID);
  assert.notEqual(first.member.id, second.member.id);
  assert.equal(verifyAccessToken(first.token, config)?.id, first.member.id);
  assert.equal(verifyAccessToken(second.token, config)?.id, second.member.id);
});

test('long and duplicate Runner names always produce immediately usable tokens', () => {
  const config = { runnerControl: { enabled: true, credentials: [] } };
  const name = 'Very Long External Runner '.repeat(20);
  const first = createRunnerCredential(config, { name, workspaceIds: ['app'] });
  const second = createRunnerCredential(config, { name, workspaceIds: ['app'] });
  assert.ok(first.credential.id.length <= MAX_GENERATED_CREDENTIAL_ID);
  assert.ok(second.credential.id.length <= MAX_GENERATED_CREDENTIAL_ID);
  assert.notEqual(first.credential.id, second.credential.id);
  assert.equal(verifyRunnerToken(first.token, config)?.id, first.credential.id);
  assert.equal(verifyRunnerToken(second.token, config)?.id, second.credential.id);
});
