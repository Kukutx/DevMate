#!/usr/bin/env node
// A real Cloudflare quick tunnel in front of a throwaway runtime, called from outside the way a cloud client does.
// It needs cloudflared and the internet, so it is run by hand and is not part of the automated checks:
//   npm run smoke:quick-tunnel [-- <path to cloudflared>]
// It proves what no local test can: that both protocol generations get through the tunnel as plain JSON, that a
// call longer than five seconds comes back, and that nothing answers without the key in the address.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startRuntime } from '../runtime/main.mjs';
import { readConfig, saveConfig } from '../runtime/config.mjs';
import { findCloudflared } from '../runtime/platform/tools.mjs';

const cloudflared = process.argv[2] ? path.resolve(process.argv[2]) : findCloudflared();
if (!cloudflared) { console.error('cloudflared is not on this computer. Install it, or pass its path.'); process.exit(2); }
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-quick-smoke-'));
const instanceRoot = path.join(base, 'instance'), projectRoot = path.join(base, 'project');
fs.mkdirSync(instanceRoot); fs.mkdirSync(projectRoot);
saveConfig(instanceRoot, { ...readConfig(instanceRoot), connection: { kind: 'cloudflare-quick', executable: cloudflared } });

// The address is a secret while the tunnel lives: what is printed never shows it.
const masked = text => String(text).replace(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g, 'https://<assigned>.trycloudflare.com').replace(/\/mcp\/[A-Za-z0-9_-]{20,}/g, '/mcp/<key>');
const say = (...parts) => console.log(masked(parts.join(' ')));
const expect = (condition, what) => { say(condition ? '[ ok ]' : '[FAIL]', what); if (!condition) failed = true; };
let failed = false;
const runtime = await startRuntime({ instanceRoot, port: 0 });
try {
  await runtime.service.call('project.create', { root: projectRoot }, { id: 'owner', role: 'owner', surface: 'local' });
  let url = null, checked = null;
  for (let attempt = 0; attempt < 60 && !checked?.verified; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    url = runtime.service.publicUrl();
    if (url) checked = await runtime.service.verifyConnection();
  }
  expect(checked?.verified === true, 'the address ' + url + ' reaches this runtime' + (checked?.verified ? ' (' + checked.tools + ' tools)' : ': ' + (checked?.reason || 'no address was given')));
  if (!checked?.verified) throw new Error('The tunnel never became reachable.');

  const post = (target, body, headers = {}) => fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
  const hello = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } };
  const origin = new URL(url).origin;
  for (const [what, target] of [['the host name alone', origin + '/mcp'], ['a wrong key', origin + '/mcp/' + 'A'.repeat(32)], ['the root', origin + '/']]) {
    const response = await post(target, hello); await response.body?.cancel();
    expect(response.status === 404, what + ' opens nothing (HTTP ' + response.status + ')');
  }
  const stream = await fetch(url, { headers: { accept: 'text/event-stream' } }); await stream.body?.cancel();
  expect(stream.status === 405, 'no event stream is offered (HTTP ' + stream.status + ')');

  const slow = { file: process.execPath, args: ['-e', 'setTimeout(() => console.log("done after eight seconds"), 8000)'], waitMs: 20000 };
  for (const [generation, negotiation] of [['2025 protocol', {}], ['current protocol', { versionNegotiation: { mode: 'auto' } }]]) {
    const seen = new Set();
    const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: async (input, init) => {
      const response = await fetch(input, init);
      seen.add((init?.method || 'GET') + ' ' + response.status + ' ' + (response.headers.get('content-type') || '-').split(';')[0]);
      return response;
    } });
    const client = new Client({ name: 'devmate-quick-smoke', version: '1' }, negotiation);
    await client.connect(transport, { timeout: 30000 });
    const tools = (await client.listTools({}, { timeout: 30000 })).tools.length, started = Date.now();
    const result = await client.callTool({ name: 'shell_run', arguments: slow }, { timeout: 60000, onprogress: () => {} });
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    await client.close().catch(() => {});
    expect(/done after eight seconds/.test(result.content?.[0]?.text || ''), generation + ': ' + tools + ' tools, and a call of ' + seconds + ' s returned its output');
    expect(![...seen].some(entry => entry.includes('event-stream')), generation + ': every answer is plain JSON (' + [...seen].join(', ') + ')');
  }
  const timings = [];
  for (let index = 0; index < 9; index++) {
    const at = performance.now();
    await (await post(url, { jsonrpc: '2.0', id: 100 + index, method: 'tools/call', params: { name: 'project_list', arguments: {} } }, { 'mcp-protocol-version': '2025-06-18' })).text();
    timings.push(performance.now() - at);
  }
  say('[info] a small tool call through the tunnel takes', Math.round(timings.sort((a, b) => a - b)[4]), 'ms (median of 9)');
} catch (error) { failed = true; say('[FAIL]', error.stack || error); }
finally {
  await runtime.stop().catch(error => say('stop:', error.message));
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
say(failed ? 'Quick tunnel: failed.' : 'Quick tunnel: works.');
process.exit(failed ? 1 : 0);
