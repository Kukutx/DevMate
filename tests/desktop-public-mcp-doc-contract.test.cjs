'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('desktop documentation describes one complete provider-neutral session lifecycle', () => {
  const obsidian = source('obsidian-plugin/README.md');
  const host = source('docs/HOST_INTEGRATION.md');
  const tunnels = source('docs/TUNNELS.md');

  assert.match(obsidian, /Gateway started or attached[\s\S]*public connection started or attached[\s\S]*MCP initialize \+ tools\/list verified[\s\S]*Ready/i);
  assert.match(obsidian, /Both hosts are first-class owners or attachers/i);
  assert.match(obsidian, /complete.*session generation/i);
  assert.match(obsidian, /Copy MCP URL.*current.*session generation/is);

  assert.match(host, /Both VS Code and Obsidian can own or attach/i);
  assert.match(host, /Start is Gateway → public connection → MCP preflight → Ready/i);
  assert.match(host, /Ready is complete-session generation scoped, never URL-only or tunnel-only/i);
  assert.match(host, /Gateway restarts[\s\S]*provider restarts/i);
  for (const provider of ['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external']) {
    assert.match(host, new RegExp(provider.replace('-', '\\-')));
  }

  assert.match(tunnels, /one shared public connection capability/i);
  assert.match(tunnels, /shared instance selects exactly one provider/i);
  assert.match(tunnels, /Both desktop hosts can own or attach/i);
  assert.match(tunnels, /complete.*session generation/i);
  assert.match(tunnels, /Gateway.*provider.*generation/is);
  assert.match(tunnels, /current local Agent endpoint API/i);
  assert.match(tunnels, /web_addr/);
});
