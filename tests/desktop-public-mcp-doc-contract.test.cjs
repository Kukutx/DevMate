'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('documentation preserves the provider-neutral desktop ownership model', () => {
  const obsidian = source('obsidian-plugin/README.md');
  const host = source('docs/HOST_INTEGRATION.md');
  const tunnels = source('docs/TUNNELS.md');

  assert.match(obsidian, /Obsidian never starts, stops, reconfigures, or takes ownership/i);
  assert.match(obsidian, /live shared tunnel record/i);
  assert.match(obsidian, /Public origin/i);
  assert.match(obsidian, /Copy MCP URL.*never falls back to localhost/is);

  assert.match(host, /ngrok/);
  assert.match(host, /cloudflare-quick/);
  assert.match(host, /cloudflare-managed/);
  assert.match(host, /external/);
  assert.match(host, /Obsidian does \*\*not\*\* instantiate a tunnel controller/i);
  assert.match(host, /VS Code\/deployment owns public ingress/i);

  assert.match(tunnels, /Provider selection is a deployment feature, not a compatibility shim/i);
  assert.doesNotMatch(tunnels, /virtual ngrok-compatible local API/i);
  assert.match(tunnels, /strict configuration matching/i);
});
