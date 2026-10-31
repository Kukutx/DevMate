import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DevMateService } from '../runtime/service.mjs';
import { createMcpServer, serverInstructions } from '../runtime/mcp.mjs';
import { clientSurfaceBy, surfaceFor } from '../runtime/surfaces.mjs';
import { startRuntime } from '../runtime/main.mjs';

// The runtimes started here look at the clients' settings (whether DevMate was added to them): those of whoever runs
// the tests are not read. Where Claude Code, Codex and Claude Desktop keep them is a folder of these tests.
const clientHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-client-home-'));
for (const name of ['APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME']) process.env[name] = clientHome;
process.on('exit', () => fs.rmSync(clientHome, { recursive: true, force: true }));
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
  for (const [said, surface] of [[{ name: 'openai-mcp' }, 'gpt'], [{ name: 'ChatGPT' }, 'gpt'], [{ userAgent: 'openai-mcp/1.0.0' }, 'gpt'],
    [{ name: 'claude-ai' }, 'claude'], [{ userAgent: 'Claude-User' }, 'claude'], [{ name: 'Anthropic/Toolbox' }, 'claude'],
    // A coding agent on this computer, by the name it gives itself (or the one DevMate's bridge carries for it in its
    // sender line), where it came the local way: it reads, writes and runs with tools of its own.
    [{ name: 'claude-code', userAgent: 'claude-code/2.1.0', local: true }, 'agent'], [{ name: 'codex-mcp-client', local: true }, 'agent'], [{ name: ' Claude-Code ', local: true }, 'agent'],
    [{ userAgent: 'devmate-mcp (claude-code)', local: true }, 'agent'], [{ userAgent: 'devmate-mcp (codex-mcp-client)', local: true }, 'agent'], [{ chosen: 'agent', name: 'my-script' }, 'agent'],
    [{ userAgent: 'claude-code/2.1.0', local: true }, 'claude'], [{ name: 'codex-mcp-client-fork', local: true }, 'gpt'],
    // The same agent on another computer, through the public address or a tunnel: DevMate's own tools are its way in.
    [{ name: 'claude-code' }, 'claude'], [{ name: 'codex-mcp-client', tunnel: true }, 'gpt'], [{ userAgent: 'devmate-mcp (claude-code)' }, 'claude'],
    [{ name: 'Visual Studio Code' }, 'generic'], [{ name: 'cursor-vscode' }, 'generic'], [{}, 'generic'], [undefined, 'generic'], [{ name: 'my-script', userAgent: 'node' }, 'generic'],
    // OpenAI's tunnel carries ChatGPT whatever it calls itself; what the client says still comes first.
    [{ tunnel: true }, 'gpt'], [{ tunnel: true, name: 'claude-ai' }, 'claude'],
    // The owner's word in the address (…/mcp?tools=claude) settles it.
    [{ chosen: 'claude', name: 'openai-mcp' }, 'claude'], [{ chosen: 'generic', tunnel: true }, 'generic'], [{ chosen: 'nonsense', name: 'openai-mcp' }, 'gpt']])
    assert.equal(clientSurfaceBy(said).surface, surface, JSON.stringify(said));
  // What decided it is kept, so that the doctor can say why a client sees the names it sees.
  assert.deepEqual([{ chosen: 'claude', name: 'openai-mcp' }, { name: 'ChatGPT' }, { userAgent: 'Claude-User' }, { tunnel: true }, { name: 'my-script' }].map(said => clientSurfaceBy(said).by), ['address', 'name', 'name', 'tunnel', 'default']);
});

test('each surface lists its tools under the names its model knows: everything that reads and the capability tools are on every list', async t => {
  const f = await fixture(t), sizes = {};
  for (const surface of ['generic', 'gpt', 'claude', 'agent']) {
    const client = await f.open({ surface, listing: true }), listed = await client.listTools();
    sizes[surface] = Buffer.byteLength(JSON.stringify(listed));
    const shown = surfaceFor(surface, f.service.processes.shell);
    // (A coding agent shows no MCP Apps: it is not given the workbench.)
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [...shown.direct.map(name => name.replace('.', '_')), ...shown.native, ...(surface === 'agent' ? [] : WORKBENCH)].sort(), surface);
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
  // Measured before the surfaces: 40,135 bytes for 39 tools. No list is longer than that; what makes a list shorter is
  // a shorter description, never a tool that is kept from the model.
  for (const [surface, bytes] of Object.entries(sizes)) assert.ok(bytes < 40135, surface + ' lists ' + bytes + ' bytes');
  // A tool a model cannot see is a tool it does not use: every surface lists whatever only reads, the capability tools
  // (the owner's browser and the other engines are behind them) and taking a change back.
  for (const surface of ['generic', 'gpt', 'claude', 'agent']) {
    const listed = (await (await f.open({ surface, listing: true })).listTools()).tools, named = new Set(listed.map(tool => tool.name));
    for (const name of ['project_list', 'project_overview', 'editor_context', 'editor_diagnostics', 'workspace_files', 'workspace_find', 'workspace_search', 'workspace_history', 'workspace_restore', 'git_status', 'git_diff', 'git_log',
      'git_show', 'git_blame', 'git_branches', 'process_list', 'providers_list', 'connection_status', 'capability_list', 'capability_query', 'capability_call', 'operations_list', 'operations_query', 'operations_call'])
      assert.ok(named.has(name), surface + ' does not list ' + name);
    for (const tool of listed.filter(item => ['capability_query', 'workspace_files', 'git_log'].includes(item.name))) assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    // What a patch or a command does as well stays one generic call away.
    for (const name of ['workspace_mkdir', 'workspace_move', 'workspace_delete']) assert.ok(!named.has(name), surface + ' lists ' + name);
  }
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
  assert.match(serverInstructions(f.service, 'claude'), /Changed files stay restorable \(workspace_history, workspace_restore\)/);
  assert.match(serverInstructions(f.service, 'gpt'), /capability_list lists engines: the owner's browser \(engine "chrome": bookmarks, tabs, history; chrome\.page\.\* debugs pages/);
});

test('a coding agent on this computer is shown what DevMate adds to its own tools: the owner\'s browser, other projects, history, running commands', async t => {
  const f = await fixture(t), listed = await (await f.open({ surface: 'agent', listing: true })).listTools(), named = new Set(listed.tools.map(tool => tool.name));
  // Nothing of DevMate's to read, write, change or run: the agent's own tools do that.
  for (const name of ['read', 'write', 'edit', 'apply_patch', 'exec_command', 'write_stdin', 'bash', 'powershell', 'workspace_read', 'workspace_write', 'workspace_edit', 'workspace_patch', 'shell_run', 'show_changes', ...WORKBENCH])
    assert.equal(named.has(name), false, name + ' is listed');
  // The owner's browser in four tools of its own: three that only read, one that changes.
  const browser = Object.fromEntries(listed.tools.filter(tool => tool.name.startsWith('browser_')).map(tool => [tool.name, tool.annotations.readOnlyHint]));
  assert.deepEqual(browser, { browser_tabs: true, browser_snapshot: true, browser_screenshot: true, browser_run: false });
  assert.ok(listed.tools.find(tool => tool.name === 'browser_run').inputSchema.properties.steps, 'browser_run takes the steps of chrome.page.run');
  // On Windows the owner's windows in four more, the same way; elsewhere there are none to read, and they are not shown.
  const desktop = Object.fromEntries(listed.tools.filter(tool => tool.name.startsWith('desktop_')).map(tool => [tool.name, tool.annotations.readOnlyHint]));
  assert.deepEqual(desktop, process.platform === 'win32' ? { desktop_windows: true, desktop_snapshot: true, desktop_screenshot: true, desktop_act: false } : {});
  assert.deepEqual(surfaceFor('agent', { kind: 'bash' }, 'linux').native.filter(name => name.startsWith('desktop_')), []);
  assert.equal(surfaceFor('agent', { kind: 'pwsh' }, 'win32').native.filter(name => name.startsWith('desktop_')).length, 4);
  // Underneath they are the capability calls, authorized as those: reading the windows is the owner's to switch on.
  const refused = await (await f.open({ surface: 'agent' })).callTool({ name: 'desktop_windows', arguments: {} });
  assert.equal(refused.isError, true); assert.match(refused.content[0].text, process.platform === 'win32' ? /"forbidden"/ : /"not_supported"/);
  // Claude Code is told how large a result may be.
  for (const tool of listed.tools) assert.equal(tool._meta?.['anthropic/maxResultSizeChars'], 140000, tool.name);
  // The instructions say what is DevMate's own, all of it within the first 512 characters (some clients read no more),
  // and name none of DevMate's tools to read, write or run, in either spelling.
  const words = serverInstructions(f.service, 'agent'), first = words.slice(0, 512);
  for (const name of ['with your own tools', 'browser_snapshot', 'project_list', 'editor_diagnostics', 'workspace_restore', 'process_stop', 'agents_delegate', 'projectId']) assert.ok(first.includes(name), name + ' is not within 512 characters');
  assert.doesNotMatch(words, /workspace[._]read|shell[._]run|apply[._]patch/);
  // The browser tools are the capability calls underneath, answered by the browser that is connected.
  const client = await f.open({ surface: 'agent' }), linkId = f.service.browser.attach({ browser: 'Test browser', extension: '4.0.6', methods: ['tabs.list'] }).linkId;
  await f.service.browser.next({ linkId, waitMs: 1000 });
  const asked = client.callTool({ name: 'browser_tabs', arguments: {} }), handed = await f.service.browser.next({ linkId, waitMs: 5000 });
  assert.deepEqual(handed.calls.map(call => call.method), ['tabs.list']);
  f.service.browser.result({ linkId, id: handed.calls[0].id, ok: true, result: { items: [{ id: 7, windowId: 1, title: 'A tab of the test', url: 'https://example.com/' }] } });
  const tabs = await asked;
  assert.equal(tabs.isError, undefined, JSON.stringify(tabs.content)); assert.match(tabs.content[0].text, /A tab of the test/);
  f.service.browser.detach({ linkId });
});

test('the instructions of every surface stay within 2000 characters, with full access and with no project, one, or many', async t => {
  // With full access and no project the instructions were 2098 characters (2108 with Windows PowerShell 5.1), and with
  // forty projects they were too long while naming none of them.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-instructions-'));
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '' });
  await service.ready;
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const shells = [service.processes.shell, { kind: 'powershell', label: 'Windows PowerShell 5.1', noChaining: true }];
  const look = what => {
    for (const shell of shells) {
      service.processes.shell = shell;
      for (const surface of ['generic', 'gpt', 'claude', 'agent']) {
        const words = serverInstructions(service, surface);
        assert.ok(words.length <= 2000, what + ', ' + shell.label + ', ' + surface + ': ' + words.length + ' characters');
        // The projects are fitted as they are written, what follows them counted ahead: the plain count, the last
        // resort where the words would not fit after all, is not what is said.
        assert.doesNotMatch(words, /projects are shared \(project_list\)/, what + ', ' + shell.label + ', ' + surface);
        // With no project, how one is shared is said on every surface: the client's way where the owner gave it one.
        if (/no project/.test(what)) assert.match(words, service.fullAccess() ? /project\.create/ : /devmate project add <folder>/, what + ', ' + shell.label + ', ' + surface);
      }
    }
    service.processes.shell = shells[0];
  };
  for (const profile of ['guarded', 'full']) { await service.call('access.update', { profile }, owner); look(profile + ', no project'); }
  for (let index = 0; index < 40; index++) { const root = path.join(temp, 'project-with-a-name-of-some-length-' + index); fs.mkdirSync(root); await service.call('project.create', { root }, owner); }
  for (const profile of ['guarded', 'full']) { await service.call('access.update', { profile }, owner); look(profile + ', forty projects'); }
  // Where there is room, projects are named before the rest is counted.
  assert.match(serverInstructions(service, 'agent'), /Projects: \S+ = project-with-a-name-of-some-length-0 .* and \d+ more \(project_list\)\./);
  // A project's name and folder are the owner's, given as they are, whatever tool names they hold.
  for (const project of service.store.list('project', { limit: 50 })) await service.call('project.remove', { id: project.id }, owner);
  await service.call('access.update', { profile: 'guarded' }, owner);
  const named = path.join(temp, 'shell_run'); fs.mkdirSync(named); await service.call('project.create', { root: named }, owner);
  for (const surface of ['gpt', 'claude']) assert.ok(serverInstructions(service, surface).includes('= shell_run (' + named + ', '), surface);
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

test('only what DevMate says is put into the names of a surface: a file, command output and instructions read are given as they are', { timeout: 60000 }, async t => {
  const f = await fixture(t), client = await f.open({ surface: 'gpt' });
  const call = async (name, args) => f.text(await client.callTool({ name, arguments: args }));
  const words = 'Call workspace_read first, then shell_run; process_read follows it.';
  fs.writeFileSync(path.join(f.root, 'AGENTS.md'), words + '\n');
  assert.match(await call('workspace_read', { path: 'AGENTS.md' }), new RegExp('1\\t' + words.replace(/[.;,]/g, '\\$&')));
  assert.ok((await call('project_overview', {})).includes(words), 'the project\'s instructions');
  fs.writeFileSync(path.join(f.root, 'says.js'), "console.log(" + JSON.stringify(words) + ");setTimeout(()=>{},3000)");
  const running = await call('shell_run', { command: run('says.js'), waitMs: 1500 });
  assert.ok(running.includes(words), running);
  // The hint after the output is DevMate's, and names the tool of this surface.
  assert.match(running, /\[still running; write_stdin \{id:"/);
});

test('the tools a GPT model knows work as it expects: read, apply_patch, exec_command, write_stdin', { timeout: 60000 }, async t => {
  const f = await fixture(t), client = await f.open({ surface: 'gpt' });
  const call = async (name, args) => f.text(await client.callTool({ name, arguments: args }));
  const applied = await call('apply_patch', { patch: '*** Begin Patch\n*** Add File: src/app.txt\n+one\n+two\n+three\n*** End Patch\n' });
  assert.match(applied, /^Changed 1 file\(s\) \(\+3 −0\):\n {2}add {4}src\/app\.txt/);
  assert.match(applied, /Take all of it back with workspace_restore \{since:\d+\}/);
  assert.match(await call('read', { path: 'src/app.txt', offset: 2, limit: 1 }), /^ {5}2\ttwo\n/);
  assert.match(await call('apply_patch', { patch: '*** Begin Patch\n*** Update File: src/app.txt\n one\n-two\n+2\n*** End Patch\n' }), /update src\/app\.txt {2}\(\+1 −1\) {2}at line 1/);
  assert.equal(fs.readFileSync(path.join(f.root, 'src', 'app.txt'), 'utf8'), 'one\n2\nthree\n');
  // A command that ends: its exit code and its output.
  fs.writeFileSync(path.join(f.root, 'answer.js'), 'console.log(6*7)');
  fs.writeFileSync(path.join(f.root, 'long.js'), "console.log('start');for(let i=0;i<4000;i++)console.log('line '+i);console.log('finish')");
  const finished = await call('exec_command', { cmd: run('answer.js') });
  assert.match(finished, /^Process exited with code 0\nOutput:\n42\s*$/);
  // A variable for this one command, under the tool's own name: a real ChatGPT found none there and went round by
  // the generic call. A name of DevMate's own is refused here as it is there.
  fs.writeFileSync(path.join(f.root, 'variable.js'), 'console.log("value:" + (process.env.PROBE_VALUE || "none"))');
  assert.match(await call('exec_command', { cmd: run('variable.js'), env: { PROBE_VALUE: '42' } }), /Output:\nvalue:42\s*$/);
  assert.match(await call('exec_command', { cmd: run('variable.js') }), /Output:\nvalue:none\s*$/);
  const own = await client.callTool({ name: 'exec_command', arguments: { cmd: run('variable.js'), env: { DEVMATE_CLIENT_COMMAND: '' } } });
  assert.equal(own.isError, true); assert.match(own.content[0].text, /invalid_command/);
  // Long output keeps its beginning and its end within the budget that was asked for.
  const long = await call('exec_command', { cmd: run('long.js'), max_output_tokens: 100 });
  assert.ok(long.length < 700, long.length + ' characters'); assert.match(long, /start/); assert.match(long, /finish/); assert.match(long, /\[… \d+ characters of output left out here …\]/);
  // A command has no input unless it is asked for. What reads its input when it is given no file (rg without a path,
  // findstr, sort) finds none and ends; with an input nobody closes it waited for the whole of yield_time_ms and ran on.
  fs.writeFileSync(path.join(f.root, 'reads.js'), "let all='';process.stdin.on('data',d=>all+=d).on('end',()=>console.log('input ended after '+all.length))");
  assert.match(await call('exec_command', { cmd: run('reads.js'), yield_time_ms: 20000 }), /^Process exited with code 0\nOutput:\ninput ended after 0\s*$/);
  // A command that keeps running hands back a session; text sent to it is answered, and only what is new comes back.
  const script = path.join(f.root, 'echo.js');
  fs.writeFileSync(script, "process.stdout.write('ready\\n');process.stdin.on('data',d=>{const s=String(d).trim();if(s==='quit')process.exit(3);process.stdout.write('got '+s+'\\n')});setInterval(()=>{},1000)");
  // Started without tty it runs on with no input, and text for it is refused with how to start it so that it takes some.
  const deaf = /^Process running with session ID (\S+)\n/.exec(await call('exec_command', { cmd: run('echo.js'), yield_time_ms: 300 }))?.[1];
  assert.ok(deaf);
  const refused = await client.callTool({ name: 'write_stdin', arguments: { session_id: deaf, chars: 'hello\n' } });
  assert.equal(refused.isError, true); assert.match(refused.content[0].text, /stdin_closed/); assert.match(refused.content[0].text, /start it again with interactive:true \(exec_command: tty:true\)/);
  await call('process_stop', { id: deaf });
  const started = await call('exec_command', { cmd: run('echo.js'), tty: true, yield_time_ms: 3000 });
  const sessionId = /^Process running with session ID (\S+)\nOutput:\n/.exec(started)?.[1];
  assert.ok(sessionId, started);
  // What a command prints arrives when it arrives, later on a busy computer: a look is repeated until it is there,
  // and what the looks brought together is what is compared.
  const printed = answer => { const at = answer.indexOf('\nOutput:\n'); return at < 0 ? '' : answer.slice(at + 9); };
  const look = () => call('write_stdin', { session_id: sessionId, yield_time_ms: 500 });
  const gathered = async (answer, wanted) => { let seen = printed(answer); for (const end = Date.now() + 30000; !wanted.test(seen) && Date.now() < end;) seen += printed(await look()); return seen; };
  assert.match(await gathered(started, /ready/), /^ready\s*$/);
  const answered = await call('write_stdin', { session_id: sessionId, chars: 'hello\n', yield_time_ms: 1500 });
  assert.match(answered, /^Process running with session ID \S+\nOutput:\n/); assert.match(await gathered(answered, /got hello/), /^got hello\s*$/, 'what was read before does not come again');
  assert.match(await call('write_stdin', { session_id: sessionId, yield_time_ms: 300 }), /^Process running with session ID \S+\nOutput:\n\s*$/, 'nothing new, and it says so by returning nothing');
  let ended = await call('write_stdin', { session_id: sessionId, chars: 'quit\n', yield_time_ms: 3000 });
  for (const end = Date.now() + 30000; !/^Process exited/.test(ended) && Date.now() < end;) ended = await look();
  assert.match(ended, /^Process exited with code 3\nOutput:/);
  const gone = await client.callTool({ name: 'write_stdin', arguments: { session_id: 'process-none' } });
  assert.equal(gone.isError, true); assert.match(gone.content[0].text, /not_found/);
  // A session of an earlier runtime is said to be that: nothing of what it once printed comes back.
  assert.match(gone.content[0].text, /It may belong to an earlier runtime session/);
  // A session whose place is not remembered (the runtime's memory of it is gone, or it was started under another
  // name) is read from its end and within the budget: a look at it never brings back the megabyte it printed before.
  fs.writeFileSync(path.join(f.root, 'flood.js'), "const line='x'.repeat(99)+'\\n';for(let i=0;i<8000;i++)process.stdout.write(line);process.stdout.write('the end\\n');process.stdin.resume()");
  const flood = await f.service.call('shell.run', { command: run('flood.js'), interactive: true, waitMs: 3000 }, connected);
  assert.equal(flood.status, 'running');
  // All of it is printed before the look. The runtime itself is asked, which moves no reader's place.
  for (const end = Date.now() + 30000; !String((await f.service.call('process.read', { id: flood.id, maxBytes: 64 }, connected)).output).includes('the end') && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 100));
  const looked = await call('write_stdin', { session_id: flood.id, yield_time_ms: 300 });
  assert.ok(looked.length < 42000, looked.length + ' characters of 800,000 printed');
  assert.match(looked, /^Process running with session ID \S+\n\[\d{6,} bytes of earlier output are not shown\]\nOutput:\n/); assert.match(looked, /the end\s*$/);
  assert.match(await call('write_stdin', { session_id: flood.id, yield_time_ms: 200 }), /^Process running with session ID \S+\nOutput:\n\s*$/, 'the next look starts where this one ended');
  await call('process_stop', { id: flood.id });
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
  // A variable for this one command, here too.
  fs.writeFileSync(path.join(f.root, 'variable.js'), 'console.log("value:" + (process.env.PROBE_VALUE || "none"))');
  assert.match(await call(SHELL_TOOL, { command: run('variable.js'), env: { PROBE_VALUE: '42' } }), /^value:42\s*\n\[exited, exit code 0\]/);
  // A command that outlives the call says, in this surface's words, how it is followed and ended.
  const running = f.service.processes.run ? await client.callTool({ name: 'workspace_read', arguments: { path: 'wait.js' } }).then(() => f.service.call('shell.run', { command: run('wait.js'), waitMs: 300 }, connected)) : null;
  assert.equal(running.status, 'running');
  const followed = await call('process_read', { id: running.id, waitMs: 100 });
  assert.match(followed, /\[still running; process_read \{id:"[^"]+", cursor:\d+, waitMs:30000\} waits for more output, process_stop ends it\]/);
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
  // The runtime remembers who asked last and what it took them for, so that the doctor can say it.
  const last = () => { const { name, surface, by } = runtime.service.lastClient; return [name, surface, by]; };
  assert.deepEqual(last(), ['openai-mcp', 'gpt', 'name']);
  const claude = await names(await connect('claude-ai'));
  assert.ok(has(claude, 'edit') && has(claude, SHELL_TOOL) && !has(claude, OTHER_SHELL_TOOL) && has(claude, 'process_read') && !has(claude, 'apply_patch'), claude.join());
  const other = await names(await connect('some-editor\u001b[31m' + 'x'.repeat(200)));
  assert.ok(has(other, 'workspace_edit') && has(other, 'shell_run') && !has(other, 'bash') && !has(other, 'powershell') && !has(other, 'apply_patch'), other.join());
  // What a client says of itself is its own text: it is kept short and printable.
  assert.deepEqual(last(), ['some-editor[31m' + 'x'.repeat(65), 'generic', 'default']);
  const unknown = (await runtime.service.call('runtime.doctor', {}, owner)).checks.find(item => item.id === 'client');
  assert.equal(unknown.status, 'info'); assert.match(unknown.detail, /^The last MCP client called itself "some-editor\[31mx+" \(sender line "[^"]*"\) and was shown the tool names of DevMate itself, because nothing about it was recognised, at 20\d\d-/);
  assert.match(unknown.fix, /add \?tools=gpt, \?tools=claude, \?tools=agent or \?tools=generic to the MCP address it uses/);
  // The runtime's own check of its public route arrives as the owner where no sign-in is asked for. It is not a client:
  // what the doctor says of the last client stays what it was.
  await names(await connect('devmate-connection-verify'));
  assert.deepEqual(last(), ['some-editor[31m' + 'x'.repeat(65), 'generic', 'default']);
  // A client of the 2025 protocol names itself once, at the start; after that its requests are told apart by their sender line.
  const older = await connect('whatever', { negotiation: {}, headers: { 'user-agent': 'openai-mcp/1.0.0' } });
  assert.ok(has(await names(older), 'exec_command'));
  assert.deepEqual([...last(), runtime.service.lastClient.userAgent], ['whatever', 'gpt', 'name', 'openai-mcp/1.0.0'], 'the name it gave at the start stays with its later requests');
  // Where its sender line says nothing about it (a library's own), the name it gave at the start is what its later
  // requests are known by; a sender line that never gave a known name is shown DevMate's own names.
  const quiet = await names(await connect('openai-mcp', { negotiation: {}, headers: { 'user-agent': 'python-httpx/0.27' } }));
  assert.ok(has(quiet, 'exec_command') && !has(quiet, 'workspace_edit'), quiet.join());
  const nobody = await names(await connect('some-tool', { negotiation: {}, headers: { 'user-agent': 'other-library/1' } }));
  assert.ok(has(nobody, 'workspace_edit') && !has(nobody, 'exec_command'), nobody.join());
  // The owner's word in the address wins over all of it.
  const chosen = await names(await connect('openai-mcp', { query: '?tools=claude' }));
  assert.ok(has(chosen, SHELL_TOOL) && !has(chosen, 'exec_command'), chosen.join());
  const told = (await runtime.service.call('runtime.doctor', {}, owner)).checks.find(item => item.id === 'client');
  assert.match(told.detail, /called itself "openai-mcp" .* and was shown the tool names of Claude, as the address it used says \(\?tools=claude\), at /); assert.equal(told.fix, undefined);
});

test('show_changes says what is uncommitted, whoever changed it, and after a review only what is new', { timeout: 60000 }, async t => {
  const f = await fixture(t), client = await f.open({ surface: 'claude' });
  const call = async (name, args = {}) => f.text(await client.callTool({ name, arguments: args }));
  const git = (...args) => { const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: f.root, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); };
  const put = (name, text) => fs.writeFileSync(path.join(f.root, name), text);
  // Without a repository there is no commit to compare with, and the answer says what there is instead.
  const none = await client.callTool({ name: 'show_changes', arguments: {} });
  assert.equal(none.isError, true); assert.match(none.content[0].text, /not_a_repository/); assert.match(none.content[0].text, /workspace_history/);
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