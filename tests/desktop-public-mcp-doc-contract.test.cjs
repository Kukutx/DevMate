'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('desktop documentation describes one complete provider-neutral MCP 2026 lifecycle with OAuth on public ingress and loopback-only no-auth', () => {
  const obsidian = source('obsidian-plugin/README.md');
  const host = source('docs/HOST_INTEGRATION.md');
  const tunnels = source('docs/TUNNELS.md');

  assert.match(obsidian, /Gateway started or attached[\s\S]*public connection started or attached[\s\S]*MCP server\/discover verified with OAuth for public ingress[\s\S]*tools\/list verified[\s\S]*gateway_status tools\/call verified[\s\S]*Ready/i);
  assert.match(obsidian, /Both hosts are first-class owners or attachers/i);
  assert.match(obsidian, /complete.*runtime generation/i);
  assert.match(obsidian, /Copy MCP URL.*current complete runtime generation/is);
  assert.match(obsidian, /MCP 2026 verification is stateless/i);
  assert.match(obsidian, /Public MCP defaults to OAuth; no-auth is limited to trusted loopback access/i);
  assert.doesNotMatch(obsidian, /MCP\s+`?initialize`?|MCP-Session-Id|mcp-session-id/i);

  assert.match(host, /Both VS Code and Obsidian can own or attach/i);
  assert.match(host, /Start is Gateway → public connection → MCP 2026 preflight with OAuth → Ready/i);
  assert.match(host, /Ready is complete-generation scoped, never URL-only or tunnel-only/i);
  assert.match(host, /Gateway restart[\s\S]*provider restart/i);
  assert.match(host, /MCP 2026 verification is stateless/i);
  assert.match(host, /Public Ready requires OAuth; no-auth is limited to trusted loopback access/i);
  assert.match(host, /Desktop public MCP defaults to OAuth/i);
  assert.match(host, /auth\.mode: "none".*trusted-loopback-only/i);
  for (const provider of ['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external']) {
    assert.match(host, new RegExp(provider.replace('-', '\\-')));
  }

  assert.match(tunnels, /one shared public connection capability/i);
  assert.match(tunnels, /shared instance selects exactly one provider/i);
  assert.match(tunnels, /Both desktop hosts can own or attach/i);
  assert.match(tunnels, /complete desktop generation/i);
  assert.match(tunnels, /Gateway \+ provider generation/i);
  assert.match(tunnels, /The MCP transport is stateless/i);
  assert.match(tunnels, /Public MCP defaults to OAuth/i);
  assert.match(tunnels, /auth\.mode: "none".*trusted-loopback-only/i);
  assert.match(tunnels, /current local Agent endpoint API/i);
  assert.match(tunnels, /web_addr/);
});
