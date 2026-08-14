'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { atomicWriteJson, newInstanceConfig, readJson } = require('../shared/config-store.cjs');
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
  atomicWriteJson(configFile, {
    version: 11,
    instanceId: 'instance-a',
    server: { port: 8787, mcpPath: '/mcp' },
    auth: { required: false, token: 'unused' },
    connection: { provider: 'cloudflare-quick', publicUrl: '' }
  });
  return { stateDirectory, configFile, record, cleanup: () => fs.rmSync(stateDirectory, { recursive: true, force: true }) };
}

function success(publicUrl) {
  return {
    publicOrigin: publicUrl,
    mcpUrl: `${publicUrl}/mcp`,
    toolCount: 131,
    server: { name: 'devmate', version: '3.4.1' }
  };
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

test('desktop hosts share one network preflight for the same connection generation', async () => {
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
    assert.equal([a.reused, b.reused].filter(Boolean).length, 1);
  } finally {
    fx.cleanup();
  }
});

test('stale Ready evidence is rechecked instead of being trusted forever', async () => {
  const fx = fixture();
  const config = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
  config.connection = {
    ...config.connection,
    ...successfulVerificationPatch(success(fx.record.publicUrl), fx.record.publicUrl, '2026-08-14T12:00:00.000Z', fx.record)
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
      ...successfulVerificationPatch(success(fx.record.publicUrl), fx.record.publicUrl, stamp, fx.record)
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
      ...successfulVerificationPatch(success(fx.record.publicUrl), fx.record.publicUrl, '2026-08-14T12:00:04.000Z', fx.record)
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
