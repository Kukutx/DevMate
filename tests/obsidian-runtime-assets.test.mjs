import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { materializeEmbeddedRuntime } = require('../obsidian-plugin/src/runtime-assets.js');

function asset(relativePath, text) {
  const data = Buffer.from(text, 'utf8');
  return {
    path: relativePath,
    contentBase64: data.toString('base64'),
    sha256: crypto.createHash('sha256').update(data).digest('hex')
  };
}

test('Obsidian marketplace runtime assets materialize into versioned private state and repair tampering', () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-obsidian-runtime-assets-'));
  const assets = [
    asset('provider-supervisor.cjs', 'provider-runtime'),
    asset(path.join('gateway', 'server.mjs'), 'gateway-runtime'),
    asset(path.join('gateway', 'agent-codex-supervisor.mjs'), 'codex-runtime')
  ];

  try {
    const first = materializeEmbeddedRuntime({ stateDirectory, version: '9.8.7', assets });
    assert.equal(fs.readFileSync(first.providerSupervisorEntry, 'utf8'), 'provider-runtime');
    assert.equal(fs.readFileSync(first.gatewayEntry, 'utf8'), 'gateway-runtime');
    assert.equal(fs.readFileSync(first.codexSupervisorEntry, 'utf8'), 'codex-runtime');
    assert.equal(first.root.startsWith(path.resolve(stateDirectory)), true);

    fs.writeFileSync(first.gatewayEntry, 'tampered', 'utf8');
    const repaired = materializeEmbeddedRuntime({ stateDirectory, version: '9.8.7', assets });
    assert.equal(fs.readFileSync(repaired.gatewayEntry, 'utf8'), 'gateway-runtime');
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});
