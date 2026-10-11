import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DevMateService } from '../runtime/service.mjs';
import { createMcpServer, serverInstructions } from '../runtime/mcp.mjs';
import { clientSurface, surfaceFor } from '../runtime/surfaces.mjs';
import { startRuntime } from '../runtime/main.mjs';

const owner = { id: 'owner', surface: 'local' }, connected = { id: 'owner' };
// A script of the project run with this Node: PowerShell needs the call operator before a quoted program.
const run = script => (process.platform === 'win32' ? '& ' : '') + '"' + process.execPath + '" ' + script;
async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-surfaces-'));
  const root = path.join(temp, 'project'); fs.mkdirSync(root);
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '' });
  await service.ready;
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const project = await service.call('project.create', { root }, owner);
  // One client of one server, as a request would be served: listing asks which tools there are, anything else may call any.
  const open = async options => {
    const server = createMcpServer(service, connected, options), client = new Client({ name: 'surface-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    t.after(async () => { await client.close(); await server.close(); });
    return client;
  };
  const text = result => { assert.equal(result.isError, undefined, JSON.stringify(result.content)); return result.content[0].text; };
  return { temp, root, service, project, open, text };
}
const names = async client => (await client.listTools()).tools.map(tool => tool.name);
const WORKBENCH = ['open_devmate_workbench', 'workbench_call'];
// Commands run in PowerShell on Windows and in bash or sh elsewhere, and the Claude surface's tool is named after that.
const SHELL_TOOL = process.platform === 'win32' ? 'powershell' : 'bash', OTHER_SHELL_TOOL = process.platform === 'win32' ? 'bash' : 'powershell';

test('a client gets the tools of the model it is: by its name, by how it reached the runtime, or as the owner chose', () => {
  for (const [said, surface] of [[{ name: 'openai-mcp' }, 'gpt'], [{ name: 'ChatGPT' }, 'gpt'], [{ name: 'codex-mcp-client' }, 'gpt'], [{ userAgent: 'openai-mcp/1.0.0' }, 'gpt'],
    [{ name: 'claude-ai' }, 'claude'], [{ name: 'claude-code', userAgent: 'claude-code/2.1.0' }, 'claude'], [{ userAgent: 'Claude-User' }, 'claude'], [{ name: 'Anthropic/Toolbox' }, 'claude'],
    [{ name: 'Visual Studio Code' }, 'generic'], [{ name: 'cursor-vscode' }, 'generic'], [{}, 'generic'], [undefined, 'generic'], [{ name: 'my-script', userAgent: 'node' }, 'generic'],
    // OpenAI's tunnel carries ChatGPT whatever it calls itself; what the client says still comes first.
    [{ tunnel: true }, 'gpt'], [{ tunnel: true, name: 'claude-ai' }, 'claude'],
    // The owner's word in the address (…/mcp?tools=claude) settles it.
    [{ chosen: 'claude', name: 'openai-mcp' }, 'claude'], [{ chosen: 'generic', tunnel: true }, 'generic'], [{ chosen: 'nonsense', name: 'openai-mcp' }, 'gpt']])
    assert.equal(clientSurface(said), surface, JSON.stringify(said));
});

test('each surface lists a handful of tools under the names its model knows, and the list is a fraction of what it was', async t => {
  const f = await fixture(t), sizes = {};
  for (const surface of ['generic', 'gpt', 'claude']) {
    const client = await f.open({ surface, listing: true }), listed = await client.listTools();
    sizes[surface] = Buffer.byteLength(JSON.stringify(listed));
    const shown = surfaceFor(surface, f.service.processes.shell);
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [...shown.direct.map(name => name.replace('.', '_')), ...shown.native, ...WORKBENCH].sort(), surface);
    // A tool's name does not promise another shell than the one that runs.
    if (surface === 'claude') { assert.ok(shown.native.includes(SHELL_TOOL) && !shown.native.includes(OTHER_SHELL_TOOL), shown.native.join()); assert.ok(listed.tools.find(tool => tool.name === SHELL_TOOL).description.includes(f.service.processes.shell.label)); }
    if (surface === 'gpt') assert.ok(listed.tools.find(tool => tool.name === 'exec_command').description.startsWith('The shell here is ' + f.service.processes.shell.label), 'the first thing exec_command says is which shell this is');
    // What the instructions and the descriptions name is there to be called: a tool of this surface, or an operation (written with a dot).
    const tools = new Set(listed.tools.map(tool => tool.name)), words = client.getInstructions() + '\n' + listed.tools.map(tool => tool.description).join('\n');
    for (const named of words.match(/\b(?:workspace|shell|process|git|project|editor|agents|operations|capability|providers|connection)_[a-z_]+\b/g) || []) assert.ok(tools.has(named), surface + ': ' + named + ' is named but not a tool here');
    assert.ok(client.getInstructions().length <= 2000, surface + ' instructions are ' + client.getInstructions().length + ' characters');
    assert.match(client.getInstructions().slice(0, 512), /project_overview/);
  }
  t.diagnostic('tools/list bytes: ' + JSON.stringify(sizes));
  // Measured before the surfaces: 40,135 bytes for 39 tools. Every surface is now under half of that.
  for (const [surface, bytes] of Object.entries(sizes)) assert.ok(bytes < 22000, surface + ' lists ' + bytes + ' bytes');
  assert.deepEqual(await names(await f.open({ surface: 'gpt', listing: true })).then(list => list.filter(name => ['read', 'apply_patch', 'exec_command', 'write_stdin'].includes(name)).length), 4);
  assert.match(serverInstructions(f.service, 'gpt'), /read with read, change with apply_patch .*, then verify with exec_command/);
  assert.match(serverInstructions(f.service, 'claude'), new RegExp('read with read, change with edit .* or write, then verify with ' + SHELL_TOOL));
  // Whatever this computer runs, both ways round: bash where commands run in bash or sh, powershell where they run in PowerShell.
  for (const [shell, named] of [[{ kind: 'sh', label: 'bash' }, 'bash'], [{ kind: 'sh', label: 'POSIX sh' }, 'bash'], [{ kind: 'powershell', label: 'Windows PowerShell 5.1', noChaining: true }, 'powershell'], [{ kind: 'powershell', label: 'PowerShell 7' }, 'powershell']]) {
    const claude = surfaceFor('claude', shell);
    assert.deepEqual([claude.native.filter(name => ['bash', 'powershell'].includes(name)), claude.names['shell.run']], [[named], named], shell.label);
    assert.equal(surfaceFor('gpt', shell).native.includes('exec_command'), true); assert.equal(surfaceFor('generic', shell).direct.includes('shell.run'), true);
  }
  assert.match(serverInstructions(f.service, 'generic'), /read with workspace_read, change with workspace_edit .*, then verify with shell_run/);
  assert.match(serverInstructions(f.service, 'gpt'), /follow it with write_stdin and stop servers with process_stop/);
  // A tool that is not listed is named as the operation it is.
  assert.match(serverInstructions(f.service, 'claude'), /Changed files stay restorable \(workspace\.history, workspace\.restore\)/);
});

test('a request that calls finds every tool, whatever list its caller was shown', async t => {
  const f = await fixture(t), client = await f.open({ surface: 'gpt' });
  const all = await names(client);
  for (const name of ['read', 'apply_patch', 'exec_command', 'write_stdin', 'write', 'edit', 'bash', 'powershell', 'workspace_read', 'workspace_history', 'git_show', 'capability_list', 'connection_status', 'project_list']) assert.ok(all.includes(name), name);
  fs.writeFileSync(path.join(f.root, 'a.txt'), 'alpha\n');
  // The names of another surface, and DevMate's own, are answered all the same.
  assert.match(f.text(await client.callTool({ name: 'workspace_read', arguments: { path: 'a.txt' } })), /1\talpha/);
  assert.match(f.text(await client.callTool({ name: 'edit', arguments: { path: 'a.txt', edits: [{ old_text: 'alpha', new_text: 'beta' }] } })), /"replacements":1/);
  assert.equal((await client.callTool({ name: 'project_list', arguments: {} })).structuredContent.items.length, 1);
});

test('the tools a GPT model knows work as it expects: read, apply_patch, exec_command, write_stdin', { timeout: 60000 }, async t => {
  const f = await fixture(t), client = await f.open({ surface: 'gpt' });
  const call = async (name, args) => f.text(await client.callTool({ name, arguments: args }));
  const applied = await call('apply_patch', { patch: '*** Begin Patch\n*** Add File: src/app.txt\n+one\n+two\n+three\n*** End Patch\n' });
  assert.match(applied, /^Changed 1 file\(s\) \(\+3 −0\):\n {2}add {4}src\/app\.txt/);
  // What a result says in words uses this surface's names: the way to take the patch back is an operation here.
  assert.match(applied, /Take all of it back with workspace\.restore \{since:\d+\}/);
  assert.match(await call('read', { path: 'src/app.txt', offset: 2, limit: 1 }), /^ {5}2\ttwo\n/);
  assert.match(await call('apply_patch', { patch: '*** Begin Patch\n*** Update File: src/app.txt\n one\n-two\n+2\n*** End Patch\n' }), /update src\/app\.txt {2}\(\+1 −1\) {2}at line 1/);
  assert.equal(fs.readFileSync(path.join(f.root, 'src', 'app.txt'), 'utf8'), 'one\n2\nthree\n');
  // A command that ends: its exit code and its output.
  fs.writeFileSync(path.join(f.root, 'answer.js'), 'console.log(6*7)');
  fs.writeFileSync(path.join(f.root, 'long.js'), "console.log('start');for(let i=0;i<4000;i++)console.log('line '+i);console.log('finish')");
  const finished = await call('exec_command', { cmd: run('answer.js') });
  assert.match(finished, /^Process exited with code 0\nOutput:\n42\s*$/);
  // Long output keeps its beginning and its end within the budget that was asked for.
  const long = await call('exec_command', { cmd: run('long.js'), max_output_tokens: 100 });
  assert.ok(long.length < 700, long.length + ' characters'); assert.match(long, /start/); assert.match(long, /finish/); assert.match(long, /\[… \d+ characters of output left out here …\]/);
  // A command that keeps running hands back a session; text sent to it is answered, and only what is new comes back.
  const script = path.join(f.root, 'echo.js');
  fs.writeFileSync(script, "process.stdout.write('ready\\n');process.stdin.on('data',d=>{const s=String(d).trim();if(s==='quit')process.exit(3);process.stdout.write('got '+s+'\\n')});");
  const started = await call('exec_command', { cmd: run('echo.js'), yield_time_ms: 3000 });
  const sessionId = /^Process running with session ID (\S+)\nOutput:\nready/.exec(started)?.[1];
  assert.ok(sessionId, started);
  assert.match(await call('write_stdin', { session_id: sessionId, chars: 'hello\n', yield_time_ms: 1500 }), /^Process running with session ID \S+\nOutput:\ngot hello\s*$/);
  assert.match(await call('write_stdin', { session_id: sessionId, yield_time_ms: 300 }), /^Process running with session ID \S+\nOutput:\n\s*$/, 'nothing new, and it says so by returning nothing');
  assert.match(await call('write_stdin', { session_id: sessionId, chars: 'quit\n', yield_time_ms: 3000 }), /^Process exited with code 3\nOutput:/);
  const gone = await client.callTool({ name: 'write_stdin', arguments: { session_id: 'process-none' } });
  assert.equal(gone.isError, true); assert.match(gone.content[0].text, /not_found/);
});

test('the tools a Claude model knows work as it expects: read, write, edit and the shell of this computer', { timeout: 60000 }, async t => {
  const f = await fixture(t), client = await f.open({ surface: 'claude' });
  const call = async (name, args) => f.text(await client.callTool({ name, arguments: args }));
  assert.match(await call('write', { path: 'notes/a.md', content: '# Title\n\nfirst\n' }), /"written":true/);
  // Writing over a file replaces it, and what was there stays restorable.
  assert.match(await call('write', { path: 'notes/a.md', content: '# Title\n\nsecond\nthird\n' }), /"written":true/);
  assert.equal((await f.service.call('workspace.history', { path: 'notes/a.md' }, owner)).items.filter(item => item.previousRestorable).length, 1);
  assert.match(await call('edit', { path: 'notes/a.md', edits: [{ old_text: 'second', new_text: '2nd' }, { old_text: 'third', new_text: '3rd' }] }), /"replacements":2/);
  assert.match(await call('read', { path: 'notes/a.md' }), /3\t2nd\n\s+4\t3rd/);
  fs.writeFileSync(path.join(f.root, 'twice.txt'), 'x\nx\n');
  const ambiguous = await client.callTool({ name: 'edit', arguments: { path: 'twice.txt', edits: [{ old_text: 'x', new_text: 'y' }] } });
  assert.equal(ambiguous.isError, true); assert.match(ambiguous.content[0].text, /edit_ambiguous/);
  fs.writeFileSync(path.join(f.root, 'answer.js'), 'console.log(6*7)');
  fs.writeFileSync(path.join(f.root, 'wait.js'), 'setInterval(()=>{},1000)');
  const ran = await call(SHELL_TOOL, { command: run('answer.js') });
  assert.match(ran, /^42\s*\n\[exited, exit code 0\]/);
  // A command that outlives the call says, in this surface's words, how it is followed and ended.
  const running = f.service.processes.run ? await client.callTool({ name: 'workspace_read', arguments: { path: 'wait.js' } }).then(() => f.service.call('shell.run', { command: run('wait.js'), waitMs: 300 }, connected)) : null;
  assert.equal(running.status, 'running');
  const followed = await call('process_read', { id: running.id, waitMs: 100 });
  assert.match(followed, /\[still running; process_read \{id:"[^"]+", cursor:\d+, waitMs:10000\} waits for more output, process_stop ends it\]/);
  await call('process_stop', { id: running.id });
});

test('over HTTP a client is shown the surface of its name or its address, and may call a tool it was not shown', { timeout: 60000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-surfaces-http-'));
  const instanceRoot = path.join(temp, 'instance'), root = path.join(temp, 'project');
  fs.mkdirSync(instanceRoot); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'a.txt'), 'alpha\n');
  const runtime = await startRuntime({ instanceRoot, port: 0, connectionFactory: () => ({ async start() {}, async stop() {}, status() { return { kind: 'local', status: 'ready' }; } }) });
  t.after(async () => { await runtime.stop(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await runtime.service.call('project.create', { root }, owner);
  const connect = async (name, { negotiation = { versionNegotiation: { mode: 'auto' } }, query = '', headers } = {}) => {
    const client = new Client({ name, version: '1' }, negotiation);
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + runtime.port + '/mcp' + query), headers ? { requestInit: { headers } } : {}));
    t.after(() => client.close().catch(() => {}));
    return client;
  };
  const has = (list, name) => list.includes(name);
  const gpt = await connect('openai-mcp'), listed = await names(gpt);
  assert.ok(has(listed, 'apply_patch') && has(listed, 'exec_command') && !has(listed, 'workspace_edit') && !has(listed, 'bash') && !has(listed, 'powershell'), listed.join());
  assert.match(gpt.getInstructions(), /change with apply_patch/);
  // Not on its list, and still its to call.
  assert.match((await gpt.callTool({ name: 'workspace_read', arguments: { path: 'a.txt' } })).content[0].text, /1\talpha/);
  assert.match((await gpt.callTool({ name: 'read', arguments: { path: 'a.txt' } })).content[0].text, /1\talpha/);
  const claude = await names(await connect('claude-ai'));
  assert.ok(has(claude, 'edit') && has(claude, SHELL_TOOL) && !has(claude, OTHER_SHELL_TOOL) && has(claude, 'process_read') && !has(claude, 'apply_patch'), claude.join());
  const other = await names(await connect('some-editor'));
  assert.ok(has(other, 'workspace_edit') && has(other, 'shell_run') && !has(other, 'bash') && !has(other, 'powershell') && !has(other, 'apply_patch'), other.join());
  // A client of the 2025 protocol names itself once, at the start; after that its requests are told apart by their sender line.
  const older = await connect('whatever', { negotiation: {}, headers: { 'user-agent': 'openai-mcp/1.0.0' } });
  assert.ok(has(await names(older), 'exec_command'));
  // The owner's word in the address wins over all of it.
  const chosen = await names(await connect('openai-mcp', { query: '?tools=claude' }));
  assert.ok(has(chosen, SHELL_TOOL) && !has(chosen, 'exec_command'), chosen.join());
});

test('show_changes says what is uncommitted, whoever changed it, and after a review only what is new', { timeout: 60000 }, async t => {
  const f = await fixture(t), client = await f.open({ surface: 'claude' });
  const call = async (name, args = {}) => f.text(await client.callTool({ name, arguments: args }));
  const git = (...args) => { const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: f.root, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); };
  const put = (name, text) => fs.writeFileSync(path.join(f.root, name), text);
  // Without a repository there is no commit to compare with, and the answer says what there is instead.
  const none = await client.callTool({ name: 'show_changes', arguments: {} });
  assert.equal(none.isError, true); assert.match(none.content[0].text, /not_a_repository/); assert.match(none.content[0].text, /workspace\.history/);
  git('init', '-q');
  put('a.txt', 'one\ntwo\nthree\n'); put('b.txt', 'b\n'); put('old.txt', 'x\ny\n'); put('r.txt', 'r1\nr2\nr3\nr4\nr5\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  assert.equal(await call('show_changes'), 'Nothing changed since the last review.');
  assert.equal(await call('show_changes', { since: 'last_commit' }), 'Nothing is uncommitted.');
  // A change by a tool, one by a command, a deletion, a rename, a new file, and a credential file that stays out of it.
  await call('edit', { path: 'a.txt', edits: [{ old_text: 'two', new_text: '2\n2.5' }] });
  fs.rmSync(path.join(f.root, 'old.txt')); git('mv', 'r.txt', 'renamed.txt'); put('new.txt', 'n1\nn2\nn3\n'); put('.env', 'TOKEN=x\n');
  const first = await call('show_changes');
  assert.match(first, /^4 file\(s\) changed \(\+5 −3\) since the last review:/);
  for (const line of ['  modified a.txt  (+2 −1)', '  deleted  old.txt  (+0 −2)', '  renamed  r.txt → renamed.txt  (+0 −0)', '  added    new.txt  (+3 −0)']) assert.ok(first.includes(line), line + '\n' + first);
  assert.match(first, /\[1 protected file\(s\) changed and are not shown\]/); assert.equal(first.includes('.env'), false);
  // Marked as reviewed, the same state has nothing new in it; a further change is the only thing shown next time.
  assert.match(await call('show_changes', { mark_reviewed: true }), /\[marked as reviewed\]$/);
  assert.equal(await call('show_changes'), 'Nothing changed since the last review.\n[4 other changed file(s) were reviewed before and are unchanged since; since:"last_commit" shows them]\n[1 protected file(s) changed and are not shown]');
  put('b.txt', 'b\nmore\n'); put('new.txt', 'n1\nn2\nn3\nn4\n');
  const next = await call('show_changes');
  assert.match(next, /^2 file\(s\) changed \(\+5 −0\) since the last review:\n {2}modified b\.txt {2}\(\+1 −0\)\n {2}added {4}new\.txt {2}\(\+4 −0\)\n\[3 other changed file/);
  assert.match(await call('show_changes', { since: 'last_commit' }), /^5 file\(s\) changed \(\+7 −3\) since the last commit:/);
  // The same operation under DevMate's own name.
  assert.match(f.text(await client.callTool({ name: 'workspace_changes', arguments: { since: 'last_commit' } })), /^5 file\(s\) changed/);
});