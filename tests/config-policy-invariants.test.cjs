'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  atomicWriteJson,
  newInstanceConfig,
  readConfigSnapshot,
  readJson,
  replaceConfig,
  updateConfig
} = require('../shared/config-store.cjs');
const { configureAuthentication, authenticationPolicyGeneration } = require('../shared/auth-config.cjs');
const { connectionPolicyGeneration, setConnectionPolicy } = require('../shared/instance-config.cjs');
const { readLifecycleIntent, setLifecycleIntent } = require('../shared/lifecycle-intent.cjs');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-policy-invariant-'));
  const file = path.join(dir, 'config.json');
  const config = newInstanceConfig({ workspaceRoot: dir, defaultConnectionProvider: 'ngrok' });
  configureAuthentication(config, 'oauth', { replace: true });
  atomicWriteJson(file, config);
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('updateConfig repairs a direct connection writer that forgot to advance generation', () => {
  const fx = fixture();
  try {
    const updated = updateConfig(fx.file, config => {
      config.connection.provider = 'cloudflare-quick';
      config.connection.publicUrl = '';
      return config;
    });
    assert.equal(updated.connection.provider, 'cloudflare-quick');
    assert.equal(connectionPolicyGeneration(updated), 1);
  } finally { fx.cleanup(); }
});

test('updateConfig repairs a direct authentication writer that forgot to advance generation', () => {
  const fx = fixture();
  try {
    const before = readJson(fx.file, null, { strict: true, supportedVersion: true });
    const updated = updateConfig(fx.file, config => {
      config.auth.mode = 'none';
      return config;
    });
    assert.equal(updated.auth.mode, 'none');
    assert.equal(authenticationPolicyGeneration(updated), authenticationPolicyGeneration(before) + 1);
  } finally { fx.cleanup(); }
});

test('updateConfig repairs a direct lifecycle writer that forgot to advance generation', () => {
  const fx = fixture();
  try {
    const updated = updateConfig(fx.file, config => {
      config.lifecycle ||= {};
      config.lifecycle.desiredState = 'running';
      return config;
    });
    assert.equal(updated.lifecycle.desiredState, 'running');
    assert.equal(updated.lifecycle.generation, 1);
  } finally { fx.cleanup(); }
});

test('canonical policy helpers are accepted without double-incrementing generations', () => {
  const fx = fixture();
  try {
    const updated = updateConfig(fx.file, config => {
      setConnectionPolicy(config, { provider: 'external', publicUrl: 'https://devmate.example.com' });
      configureAuthentication(config, 'none', { replace: true });
      return config;
    });
    assert.equal(connectionPolicyGeneration(updated), 1);
    assert.equal(authenticationPolicyGeneration(updated), 2);

    const lifecycle = setLifecycleIntent(fx.file, 'running', { requestedBy: 'test', reason: 'canonical helper' });
    assert.equal(lifecycle.changed, true);
    assert.equal(lifecycle.generation, 1);
    const repeated = setLifecycleIntent(fx.file, 'running', { requestedBy: 'test', reason: 'same state' });
    assert.equal(repeated.changed, false);
    assert.equal(readLifecycleIntent(fx.file).generation, 1);
  } finally { fx.cleanup(); }
});

test('connection metadata writes do not advance policy or lifecycle generations', () => {
  const fx = fixture();
  try {
    const before = readJson(fx.file, null, { strict: true, supportedVersion: true });
    const updated = updateConfig(fx.file, config => {
      config.connection.lastCopiedAt = new Date().toISOString();
      return config;
    });
    assert.equal(connectionPolicyGeneration(updated), connectionPolicyGeneration(before));
    assert.equal(authenticationPolicyGeneration(updated), authenticationPolicyGeneration(before));
    assert.equal(updated.lifecycle?.generation ?? 0, before.lifecycle?.generation ?? 0);
  } finally { fx.cleanup(); }
});

test('same-policy generation jumps are rejected as unjustified', () => {
  const fx = fixture();
  try {
    assert.throws(() => updateConfig(fx.file, config => {
      config.connection.policyGeneration += 1;
      return config;
    }), error => error?.code === 'connection_policy_generation_unjustified');

    assert.throws(() => updateConfig(fx.file, config => {
      config.hostRuntime.authenticationPolicyGeneration += 1;
      return config;
    }), error => error?.code === 'authentication_policy_generation_unjustified');

    assert.throws(() => updateConfig(fx.file, config => {
      config.lifecycle ||= { desiredState: 'stopped', generation: 0 };
      config.lifecycle.generation += 1;
      return config;
    }), error => error?.code === 'lifecycle_generation_unjustified');
  } finally { fx.cleanup(); }
});

test('policy changes cannot forge a rollback or multi-step generation jump', () => {
  const fx = fixture();
  try {
    assert.throws(() => updateConfig(fx.file, config => {
      config.connection.provider = 'cloudflare-quick';
      config.connection.policyGeneration = 9;
      return config;
    }), error => error?.code === 'connection_policy_generation_invalid_transition');

    assert.throws(() => updateConfig(fx.file, config => {
      config.auth.mode = 'none';
      config.hostRuntime.authenticationPolicyGeneration = 9;
      return config;
    }), error => error?.code === 'authentication_policy_generation_invalid_transition');

    assert.throws(() => updateConfig(fx.file, config => {
      config.lifecycle ||= {};
      config.lifecycle.desiredState = 'running';
      config.lifecycle.generation = 9;
      return config;
    }), error => error?.code === 'lifecycle_generation_invalid_transition');
  } finally { fx.cleanup(); }
});

test('replaceConfig applies the same invariant to snapshot-based writers', () => {
  const fx = fixture();
  try {
    const snapshot = readConfigSnapshot(fx.file);
    snapshot.connection.provider = 'cloudflare-quick';
    snapshot.lifecycle ||= {};
    snapshot.lifecycle.desiredState = 'running';
    const updated = replaceConfig(fx.file, snapshot);
    assert.equal(updated.connection.provider, 'cloudflare-quick');
    assert.equal(connectionPolicyGeneration(updated), 1);
    assert.equal(updated.lifecycle.generation, 1);
  } finally { fx.cleanup(); }
});

test('an existing instance identity cannot be replaced to reset policy generations', () => {
  const fx = fixture();
  try {
    const before = readJson(fx.file, null, { strict: true, supportedVersion: true });
    assert.throws(() => updateConfig(fx.file, () => {
      const fresh = newInstanceConfig({ workspaceRoot: fx.dir, defaultConnectionProvider: 'cloudflare-quick' });
      configureAuthentication(fresh, 'none', { replace: true });
      return fresh;
    }), error => error?.code === 'config_instance_identity_change_forbidden');
    const after = readJson(fx.file, null, { strict: true, supportedVersion: true });
    assert.equal(after.instanceId, before.instanceId);
    assert.equal(connectionPolicyGeneration(after), connectionPolicyGeneration(before));
    assert.equal(authenticationPolicyGeneration(after), authenticationPolicyGeneration(before));
  } finally { fx.cleanup(); }
});
