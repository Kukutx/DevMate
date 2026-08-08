'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('documentation preserves the complete provider-neutral desktop ownership model', () => {
  const obsidian = source('obsidian-plugin/README.md');
  const host = source('docs/HOST_INTEGRATION.md');
  const tunnels = source('docs/TUNNELS.md');

  assert.match(obsidian, /Gateway started or attached[\s\S]*public connection started or attached[\s\S]*MCP initialize \+ tools\/list verified[\s\S]*Ready/i);
  assert.match(obsidian, /Both hosts are first-class owners or attachers/i);
  assert.match(obsidian, /current public connection generation/i);
  assert.match(obsidian, /Copy MCP URL.*verify the current public connection generation/is);
  assert.doesNotMatch(obsidian, /never starts, stops, reconfigures, or takes ownership/i);

  assert.match(host, /Both VS Code and Obsidian can own or attach/i);
  assert.match(host, /Start is Gateway → public connection → MCP preflight → Ready/i);
  assert.match(host, /Ready is generation-scoped, never URL-only/i);
  assert.match(host, /ngrok/);
  assert.match(host, /cloudflare-quick/);
  assert.match(host, /cloudflare-managed/);
  assert.match(host, /external/);
  assert.doesNotMatch(host, /Obsidian does \*\*not\*\* instantiate a tunnel controller/i);
  assert.doesNotMatch(host, /VS Code\/deployment owns public ingress/i);

  assert.match(tunnels, /Provider selection is a \*\*connection capability\*\*, not a runtime mode and not a compatibility shim/i);
  assert.match(tunnels, /Both desktop hosts can own or attach/i);
  assert.match(tunnels, /Verification is tied to the provider record generation/i);
  assert.doesNotMatch(tunnels, /virtual ngrok-compatible local API/i);
  assert.doesNotMatch(tunnels, /deployment mode/i);
});
