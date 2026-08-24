'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const oauthSecrets = require('../shared/oauth-secrets.cjs');

function tempConfig() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-oauth-secret-recovery-'));
  return { directory, configPath: path.join(directory, 'config.json') };
}

test('recovers the previous OAuth signing material after an interrupted Windows-style replacement', t => {
  const { directory, configPath } = tempConfig();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = oauthSecrets.ensureOAuthSecrets(configPath);
  const file = oauthSecrets.oauthSecretsPath(configPath);
  const replacement = `${file}.replace-crash-test`;

  fs.renameSync(file, replacement);
  assert.equal(fs.existsSync(file), false);
  const recovered = oauthSecrets.ensureOAuthSecrets(configPath);

  assert.equal(recovered.signingKey, first.signingKey);
  assert.equal(recovered.ownerApprovalCode, first.ownerApprovalCode);
  assert.equal(recovered.generation, first.generation);
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(replacement), false);
});

test('read and rotation recover signing material before use', t => {
  const { directory, configPath } = tempConfig();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = oauthSecrets.ensureOAuthSecrets(configPath);
  const file = oauthSecrets.oauthSecretsPath(configPath);
  const replacement = `${file}.replace-crash-test`;
  fs.renameSync(file, replacement);

  const read = oauthSecrets.readOAuthSecrets(configPath);
  assert.equal(read.signingKey, first.signingKey);
  const rotated = oauthSecrets.rotateOwnerApprovalCode(configPath, first.ownerApprovalCode);
  assert.equal(rotated.signingKey, first.signingKey);
  assert.equal(rotated.generation, first.generation + 1);
});

test('never replaces unreadable OAuth secrets with a fresh identity when recovery evidence exists but is invalid', t => {
  const { directory, configPath } = tempConfig();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = oauthSecrets.oauthSecretsPath(configPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{broken-json', 'utf8');
  fs.writeFileSync(`${file}.replace-unknown`, '{also-broken', 'utf8');

  assert.throws(() => oauthSecrets.ensureOAuthSecrets(configPath));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken-json');
});
