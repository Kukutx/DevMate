'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { authenticationPolicyGeneration, configureAuthentication } = require('../shared/auth-config.cjs');
const { DEFAULT_VERSION, atomicWriteJson, newInstanceConfig, readJson } = require('../shared/config-store.cjs');
const { setDesktopAuthenticationMode } = require('../shared/desktop-auth-policy.cjs');
const {
  recordVerificationFailure,
  verifySharedPublicMcp
} = require('../host/shared-public-mcp-verification.js');
const { successfulVerificationPatch, verifiedForCurrentRecord } = require('../shared/public-ingress-verification.cjs');

function fixture() {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-shared-public-check-'));
  const configFile = path.join(stateDirectory, 'config.json');
  const record = {
    ownerId: 'owner-a',
    provider: 'cloudflare-quick',
    port: 8787,
    status: 'ready',
    publicUrl: 'https://shared.example.com',
    readyAt: '2026-08-14T12:00:00.000Z',
    gatewayGeneration: 'gateway-a'
  };
  const config = newInstanceConfig({
    workspaceRoot: stateDirectory,
    port: 8787,
    appVersion: DEFAULT_VERSION,
    defaultConnectionProvider: 'cloudflare-quick'
  });
  config.instanceId = 'instance-a';
  config.lifecycle = {
    desiredState: 'running',
    generation: 1,
    updatedAt: '2026-08-14T11:59:59.000Z',
    requestedBy: 'test',
    reason: 'test'
  };
  configureAuthentication(config, 'oauth', { replace: true });
  atomicWriteJson(configFile, config);
  return { stateDirectory, configFile, record, cleanup: () => fs.rmSync(stateDirectory, { recursive: true, force: true }) };
}

function success(publicUrl) {
  return {
    publicOrigin: publicUrl,
    mcpUrl: `${publicUrl}/mcp`,
    toolCount: 131,
    toolCallVerified: true,
    probeTool: 'gateway_status',
    server: { name: 'devmate', version: DEFAULT_VERSION }
  };
}

function verificationPatch(fx, stamp) {
  const config = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
  return successfulVerificationPatch(
    success(fx.record.publicUrl),
    fx.record.publicUrl,
    stamp,
    fx.record,
    null,
    config.auth.mode,
    authenticationPolicyGeneration(config)
  );
}

test('desktop callers can select the account-free provider without changing standalone defaults', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-desktop-default-'));
  try {
    assert.equal(newInstanceConfig({ workspaceRoot }).connection.provider, 'ngrok');
    assert.equal(newInstanceConfig({ workspaceRoot, defaultConnectionProvider: 'cloudflare-quick' }).connection.provider, 'cloudflare-quick');
    assert.throws(() => newInstanceConfig({ workspaceRoot, defaultConnectionProvider: 'guess' }), /Unknown default connection provider/);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('desktop hosts share one network preflight for the same connection and auth generation', async () => {
  const fx = fixture();
  let calls = 0;
  let release;
  const preflight = async input => {
    calls += 1;
    await new Promise(resolve => { release = resolve; });
    return success(input.publicUrl);
  };
  const options = clientName => ({
    stateDirectory: fx.stateDirectory,
    configFile: fx.configFile,
    publicUrl: fx.record.publicUrl,
    expectedRecord: fx.record,
    currentRecord: () => fx.record,
    clientName,
    preflight
  });

  try {
    const first = verifySharedPublicMcp(options('vscode'));
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const second = verifySharedPublicMcp(options('obsidian'));
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal(a.test.toolCount, 131);
    assert.equal(b.test.toolCount, 131);
    assert.equal(a.test.toolCallVerified, true);
    assert.equal(b.test.toolCallVerified, true);
    assert.equal([a.reused, b.reused].filter(Boolean).length, 1);
    const persisted = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    assert.equal(persisted.connection.lastAuthGeneration, authenticationPolicyGeneration(persisted));
  } finally {
    fx.cleanup();
  }
});

test('stale Ready evidence is rechecked instead of being trusted forever', async () => {
  const fx = fixture();
  const config = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
  config.connection = {
    ...config.connection,
    ...verificationPatch(fx, '2026-08-14T12:00:00.000Z')
  };
  atomicWriteJson(fx.configFile, config);
  let calls = 0;
  try {
    await assert.rejects(verifySharedPublicMcp({
      stateDirectory: fx.stateDirectory,
      configFile: fx.configFile,
      publicUrl: fx.record.publicUrl,
      expectedRecord: fx.record,
      currentRecord: () => fx.record,
      maxEvidenceAgeMs: 1000,
      now: () => Date.parse('2026-08-14T12:00:02.000Z'),
      preflight: async () => {
        calls += 1;
        throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      }
    }), /timeout/);
    assert.equal(calls, 1);
    const failed = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    assert.equal(verifiedForCurrentRecord(failed, fx.record), false);
    assert.equal(failed.connection.lastErrorKind, 'temporary-network');
  } finally {
    fx.cleanup();
  }
});

test('a fresh failed probe invalidates older Ready evidence but preserves a newer concurrent success', () => {
  const fx = fixture();
  try {
    const stamp = '2026-08-14T12:00:01.000Z';
    const config = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    config.connection = {
      ...config.connection,
      ...verificationPatch(fx, stamp)
    };
    atomicWriteJson(fx.configFile, config);
    assert.equal(verifiedForCurrentRecord(config, fx.record), true);

    const generation = require('../shared/public-ingress-verification.cjs').recordGeneration(fx.record);
    recordVerificationFailure(fx.configFile, () => fx.record, generation, Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), () => Date.parse('2026-08-14T12:00:02.000Z'), () => true, () => null, Date.parse('2026-08-14T12:00:01.500Z'));
    const failed = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    assert.equal(verifiedForCurrentRecord(failed, fx.record), false);
    assert.equal(failed.connection.lastError, 'timeout');

    failed.connection = {
      ...failed.connection,
      ...verificationPatch(fx, '2026-08-14T12:00:04.000Z')
    };
    atomicWriteJson(fx.configFile, failed);
    recordVerificationFailure(fx.configFile, () => fx.record, generation, Object.assign(new Error('late timeout'), { code: 'ETIMEDOUT' }), () => Date.parse('2026-08-14T12:00:05.000Z'), () => true, () => null, Date.parse('2026-08-14T12:00:03.000Z'));
    const preserved = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    assert.equal(verifiedForCurrentRecord(preserved, fx.record), true);
    assert.equal(preserved.connection.lastError, '');
  } finally {
    fx.cleanup();
  }
});

test('OAuth-none-OAuth ABA during preflight cannot stamp old evidence onto the new policy generation', async () => {
  const fx = fixture();
  let release;
  const preflightStarted = new Promise(resolve => { release = resolve; });
  let complete;
  const hold = new Promise(resolve => { complete = resolve; });

  try {
    const verification = verifySharedPublicMcp({
      stateDirectory: fx.stateDirectory,
      configFile: fx.configFile,
      publicUrl: fx.record.publicUrl,
      expectedRecord: fx.record,
      currentRecord: () => fx.record,
      preflight: async input => {
        release();
        await hold;
        return success(input.publicUrl);
      }
    });

    await preflightStarted;
    const before = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    const beforeGeneration = authenticationPolicyGeneration(before);
    setDesktopAuthenticationMode(fx.configFile, 'none');
    setDesktopAuthenticationMode(fx.configFile, 'oauth');
    const after = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    assert.equal(after.auth.mode, 'oauth');
    assert.equal(authenticationPolicyGeneration(after), beforeGeneration + 2);

    complete();
    await assert.rejects(verification, error => error?.code === 'DEVMATE_PUBLIC_MCP_AUTH_POLICY_CHANGED');
    const persisted = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    assert.equal(verifiedForCurrentRecord(persisted, fx.record), false);
    assert.notEqual(persisted.connection.lastAuthGeneration, authenticationPolicyGeneration(persisted));
  } finally {
    complete?.();
    fx.cleanup();
  }
});
