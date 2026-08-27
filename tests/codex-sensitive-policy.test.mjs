import assert from 'node:assert/strict';
import test from 'node:test';
import { proposalTextPath } from '../gateway/agent-snapshot.mjs';
import { isSensitiveWorkspacePath } from '../gateway/sensitive-path-policy.mjs';

test('Codex text snapshot inherits shared credential-directory exclusions', () => {
  for (const rel of [
    '.pulumi/config.yaml',
    '.serverless/config.yml',
    '.wrangler/config.toml',
    '.aws/settings.json',
    '.azure/profile.json',
    '.kube/config.yaml',
    '.docker/config.json',
    '.npmrc',
    '.dev.vars',
    'keys/release.p12'
  ]) {
    assert.equal(isSensitiveWorkspacePath(rel), true, `shared policy: ${rel}`);
    assert.equal(proposalTextPath(rel), false, `Codex snapshot: ${rel}`);
  }
});

test('shared policy integration preserves normal project text and environment examples', () => {
  for (const rel of [
    'src/app.js',
    'config/settings.yaml',
    '.env.example',
    'README.md',
    '.codex/rules/project.md',
    '.openai/project.md',
    'frontend/app/android/gradle.properties',
    'logs/build.log'
  ]) {
    assert.equal(isSensitiveWorkspacePath(rel), false, rel);
    assert.equal(proposalTextPath(rel), true, rel);
  }
});

test('database files are ordinary project data but remain non-text snapshot inputs', () => {
  for (const rel of ['data/app.db', 'data/cache.sqlite', 'data/cache.sqlite3']) {
    assert.equal(isSensitiveWorkspacePath(rel), false, rel);
    assert.equal(proposalTextPath(rel), false, rel);
  }
});

test('credential-shaped files stay blocked inside otherwise readable project metadata directories', () => {
  for (const rel of [
    '.codex/.env',
    '.codex/credentials.json',
    '.codex/keys/release.key',
    '.openai/.env',
    '.openai/credentials.json',
    '.openai/keys/release.key'
  ]) {
    assert.equal(isSensitiveWorkspacePath(rel), true, rel);
    assert.equal(proposalTextPath(rel), false, rel);
  }
});
