import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startRuntime } from '../runtime/main.mjs';
import { runtimeStatus, stopRuntime } from '../runtime/launcher.mjs';

const localConnection = () => ({ async start() {}, async stop() {}, status() { return { kind: 'local', status: 'ready' }; } });
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
// A client that starts its MCP server as a program, the way desktop clients do.
async function stdioClient(args, options) {
  const noise = [];
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('runtime/cli.mjs'), 'mcp', ...args], stderr: 'pipe' });
  transport.stderr?.on('data', chunk => noise.push(String(chunk)));
  const client = new Client({ name: 'devmate-stdio-test', version: '1' }, options);
  await client.connect(transport);
  return { client, noise };
}
const textOf = result => result.content.map(part => part.text).join('\n');

test('a client that speaks MCP over standard input and output works through devmate mcp, in both protocol generations', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-stdio-'));
  const instanceRoot = path.join(temp, 'instance'), root = path.join(temp, 'project');
  fs.mkdirSync(root);
  const runtime = await startRuntime({ instanceRoot, port: 0, connectionFactory: localConnection });
  // The folder is shared by its owner, at the computer; the client works in it.
  await runtime.service.call('project.create', { root, name: 'Over stdio' }, { id: 'owner', role: 'owner', surface: 'local' });
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await runtime.stop();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  for (const [generation, options] of [['handshake', {}], ['per-request', { versionNegotiation: { mode: 'auto' } }]]) {
    const { client } = await stdioClient(['--instance', instanceRoot], options);
    clients.push(client);
    assert.match(client.getInstructions(), /^DevMate works directly in software projects/, generation + ': the working instructions arrive');
    const tools = (await client.listTools()).tools;
    assert.ok(tools.length >= 35, generation + ': ' + tools.length + ' tools');
    assert.equal(tools.find(tool => tool.name === 'workspace_read').title, 'Read file');
    const file = generation + '.txt';
    const written = await client.callTool({ name: 'workspace_write', arguments: { path: file, text: 'written through the ' + generation + ' client\nsecond line' } });
    assert.equal(written.structuredContent.written, true);
    assert.match(textOf(await client.callTool({ name: 'workspace_read', arguments: { path: file } })), new RegExp('^\\s+1\\twritten through the ' + generation + ' client\\n\\s+2\\tsecond line'));
    const ran = await client.callTool({ name: 'shell_run', arguments: { file: process.execPath, args: ['-p', '6*7'] } });
    assert.match(textOf(ran), /^42\s/);
    // A failure is an answer too, not a hang or a crash of the bridge.
    const missing = await client.callTool({ name: 'workspace_read', arguments: { path: 'no-such-file.txt' } });
    assert.equal(missing.isError, true); assert.match(textOf(missing), /not_found/);
    assert.equal(fs.readFileSync(path.join(root, file), 'utf8').split('\n')[1], 'second line');
  }
});

test('what happens to one request never decides another: a refused request is answered as refused while a command keeps running', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-stdio-siblings-'));
  const instanceRoot = path.join(temp, 'instance'), root = path.join(temp, 'project');
  fs.mkdirSync(root);
  const runtime = await startRuntime({ instanceRoot, port: 0, connectionFactory: localConnection });
  await runtime.service.call('project.create', { root }, { id: 'owner', role: 'owner', surface: 'local' });
  const { client } = await stdioClient(['--instance', instanceRoot], { versionNegotiation: { mode: 'auto' } });
  t.after(async () => { await client.close().catch(() => {}); await runtime.stop(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const slow = client.callTool({ name: 'shell_run', arguments: { file: process.execPath, args: ['-e', 'setTimeout(() => console.log("slow command done"), 1500)'], waitMs: 20000 } });
  await new Promise(resolve => setTimeout(resolve, 300));
  // More than the runtime reads in one request.
  await assert.rejects(client.callTool({ name: 'workspace_write', arguments: { path: 'too-large.txt', text: 'x'.repeat(17 * 1024 * 1024) } }));
  assert.match(textOf(await slow), /slow command done/);
  assert.equal(fs.existsSync(path.join(root, 'too-large.txt')), false);
  // The bridge is as usable afterwards as before.
  assert.match(textOf(await client.callTool({ name: 'shell_run', arguments: { file: process.execPath, args: ['-p', '6*7'] } })), /^42\s/);
});

test('devmate mcp starts the runtime when none is running and keeps working when the runtime is restarted', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-stdio-start-'));
  const instanceRoot = path.join(temp, 'instance'), port = await freePort();
  let client;
  t.after(async () => {
    await client?.close().catch(() => {});
    await stopRuntime({ instanceRoot, timeoutMs: 20000 }).catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  assert.equal((await runtimeStatus({ instanceRoot })).running, false);
  const started = await stdioClient(['--instance', instanceRoot, '--port', String(port)]);
  client = started.client;
  const first = await runtimeStatus({ instanceRoot });
  assert.deepEqual([first.running, first.record.port], [true, port], 'the stdio entry brought the runtime up');
  assert.ok((await client.listTools()).tools.length >= 35);
  assert.ok(started.noise.join('').includes('starting the runtime'), 'what it did is said on standard error, never on the protocol stream');
  // The runtime goes away under the connected client and comes back on the next call.
  await stopRuntime({ instanceRoot, timeoutMs: 20000 });
  assert.equal((await runtimeStatus({ instanceRoot })).running, false);
  const listed = await client.callTool({ name: 'project_list', arguments: {} });
  assert.deepEqual(listed.structuredContent.items, []);
  const second = await runtimeStatus({ instanceRoot });
  assert.equal(second.running, true); assert.notEqual(second.record.generation, first.record.generation);
});
