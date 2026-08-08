'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { atomicWriteJson } = require('../shared/config-store.cjs');
const { PublicTunnelVerifier } = require('../vscode-host/public-tunnel-verifier.js');

function stateDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-tunnel-conflict-'));
  atomicWriteJson(path.join(directory, 'config.json'), {
    version: 11,
    server: { port: 8787, mcpPath: '/mcp' },
    auth: { required: true, token: 'owner' },
    deployment: { mode: 'team', tunnelProvider: 'cloudflare-managed', publicUrl: 'https://new.example.com' },
    connection: {}
  });
  return directory;
}

test('configuration conflict never attempts MCP against the stale endpoint and invokes fail-closed reconciliation', async () => {
  const directory = stateDirectory();
  const states = [];
  let reconciles = 0;
  let preflights = 0;
  try {
    const verifier = new PublicTunnelVerifier({
      stateDirectory: directory,
      tunnelStatus: () => {
        const error = new Error('active ngrok differs from desired cloudflare-managed');
        error.code = 'DEVMATE_TUNNEL_CONFIGURATION_CONFLICT';
        error.activeProvider = 'ngrok';
        error.requestedProvider = 'cloudflare-managed';
        throw error;
      },
      onStateChange: async event => states.push(event.state),
      onConfigurationConflict: async ({ error }) => {
        reconciles += 1;
        assert.equal(error.activeProvider, 'ngrok');
        assert.equal(error.requestedProvider, 'cloudflare-managed');
        return { stopped: true };
      },
      preflight: async () => {
        preflights += 1;
        return {};
      }
    });
    const result = await verifier.check();
    assert.equal(result.reason, 'configuration-conflict');
    assert.equal(result.cleanup.stopped, true);
    assert.deepEqual(states, ['configuration-conflict']);
    assert.equal(reconciles, 1);
    assert.equal(preflights, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('configuration-conflict cleanup is retried while stale runtime remains but state notification stays deduplicated', async () => {
  const directory = stateDirectory();
  let states = 0;
  let reconciles = 0;
  try {
    const verifier = new PublicTunnelVerifier({
      stateDirectory: directory,
      tunnelStatus: () => {
        const error = new Error('mismatch');
        error.code = 'DEVMATE_TUNNEL_CONFIGURATION_CONFLICT';
        throw error;
      },
      onStateChange: async () => { states += 1; },
      onConfigurationConflict: async () => {
        reconciles += 1;
        return { stopped: false, reason: 'process-exit-timeout' };
      }
    });
    await verifier.check();
    await verifier.check();
    assert.equal(states, 1);
    assert.equal(reconciles, 2, 'cleanup must be retried if a stale tunnel still conflicts');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('VS Code wrapper stops its owned stale tunnel and never auto-launches the replacement provider', () => {
  const root = path.resolve(__dirname, '..');
  const wrapper = fs.readFileSync(path.join(root, 'extension-entry-shared-tunnel.js'), 'utf8');
  assert.match(wrapper, /onConfigurationConflict: async \(\) => stopConfigurationConflict\(\)/);
  assert.match(wrapper, /const result = await runtime\.stop\(\)/);
  assert.match(wrapper, /shared deployment configuration changed/);
  const start = wrapper.indexOf('async function stopConfigurationConflict');
  const end = wrapper.indexOf('function createPublicVerifier', start);
  assert.ok(start >= 0 && end > start);
  const block = wrapper.slice(start, end);
  assert.doesNotMatch(block, /runtime\.start\(|startTunnel\(/);
});
