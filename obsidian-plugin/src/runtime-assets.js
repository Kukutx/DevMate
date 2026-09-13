'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function compiledValue(factory) {
  try { return String(factory() || ''); }
  catch { return ''; }
}

const EMBEDDED_ASSETS = Object.freeze([
  {
    path: 'provider-supervisor.cjs',
    contentBase64: compiledValue(() => __DEVMATE_PROVIDER_SUPERVISOR_BASE64__),
    sha256: compiledValue(() => __DEVMATE_PROVIDER_SUPERVISOR_SHA256__)
  },
  {
    path: path.join('gateway', 'server.mjs'),
    contentBase64: compiledValue(() => __DEVMATE_GATEWAY_BASE64__),
    sha256: compiledValue(() => __DEVMATE_GATEWAY_SHA256__)
  },
  {
    path: path.join('gateway', 'agent-codex-supervisor.mjs'),
    contentBase64: compiledValue(() => __DEVMATE_CODEX_SUPERVISOR_BASE64__),
    sha256: compiledValue(() => __DEVMATE_CODEX_SUPERVISOR_SHA256__)
  }
]);

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function ensureRestrictiveDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
}

function writeVerifiedAsset(root, asset) {
  const target = path.join(root, asset.path);
  const data = Buffer.from(String(asset.contentBase64 || ''), 'base64');
  const expected = String(asset.sha256 || '').toLowerCase();
  if (!data.length || !/^[a-f0-9]{64}$/.test(expected) || hash(data) !== expected) {
    throw new Error(`Embedded DevMate Obsidian runtime asset is invalid: ${asset.path}`);
  }

  const existing = fs.statSync(target, { throwIfNoEntry: false });
  if (existing?.isFile()) {
    const current = fs.readFileSync(target);
    if (hash(current) === expected) return target;
  }

  ensureRestrictiveDirectory(path.dirname(target));
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, data, { mode: 0o600 });
  try { fs.chmodSync(temporary, 0o600); } catch {}
  try {
    fs.rmSync(target, { force: true });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return target;
}

function materializeEmbeddedRuntime({ stateDirectory, version, assets = EMBEDDED_ASSETS }) {
  const normalizedVersion = String(version || '').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalizedVersion)) {
    throw new Error(`Invalid DevMate Obsidian runtime version: ${normalizedVersion || '(empty)'}`);
  }
  const stateRoot = path.resolve(String(stateDirectory || ''));
  if (!stateRoot) throw new Error('DevMate Obsidian runtime state directory is required');

  const runtimeRoot = path.join(stateRoot, 'host-runtime', 'obsidian', normalizedVersion);
  ensureRestrictiveDirectory(runtimeRoot);
  const materialized = new Map();
  for (const asset of assets) materialized.set(asset.path, writeVerifiedAsset(runtimeRoot, asset));

  return {
    root: runtimeRoot,
    providerSupervisorEntry: materialized.get('provider-supervisor.cjs'),
    gatewayEntry: materialized.get(path.join('gateway', 'server.mjs')),
    codexSupervisorEntry: materialized.get(path.join('gateway', 'agent-codex-supervisor.mjs'))
  };
}

module.exports = {
  materializeEmbeddedRuntime,
  __test: { hash, writeVerifiedAsset }
};
