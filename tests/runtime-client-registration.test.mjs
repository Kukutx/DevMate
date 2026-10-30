import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLIENTS, clientFile, createClientRegistration } from '../runtime/platform/client-registration.mjs';
import { main } from '../runtime/cli.mjs';
import { CLIENT_COMMAND_ENV } from '../runtime/client.mjs';

// A home of its own for every test: the clients' settings files are the owner's, and are never touched here.
function place(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-clients-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = path.join(root, 'home'), instance = path.join(root, 'instance'), env = { CODEX_HOME: path.join(home, 'codex-home'), APPDATA: path.join(home, 'roaming') };
  fs.mkdirSync(home); fs.mkdirSync(instance);
  return { root, home, instance, env };
}
const output = () => { let text = ''; return { write(value) { text += value; }, get text() { return text; } }; };

test('each client is given DevMate in its own settings file, where its documentation puts it, and nothing else there changes', t => {
  const { home, instance, env } = place(t);
  // What the owner has there already: other servers, other settings, comments.
  const claude = clientFile('claude-code', { home, env }), codex = clientFile('codex', { home, env }), desktop = clientFile('claude-desktop', { platform: 'win32', home, env });
  assert.deepEqual([claude, codex, desktop], [path.join(home, '.claude.json'), path.join(env.CODEX_HOME, 'config.toml'), path.join(env.APPDATA, 'Claude', 'claude_desktop_config.json')]);
  assert.equal(clientFile('claude-desktop', { platform: 'darwin', home, env }), path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  fs.writeFileSync(claude, JSON.stringify({ numStartups: 7, mcpServers: { other: { type: 'stdio', command: 'other' } }, projects: { a: { x: 1 } } }));
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  // (Written with Windows line endings, an older devmate table in the middle, and a comment that belongs to the table after it.)
  const tomlBefore = '# my settings\nmodel = "gpt"\n\n[mcp_servers.devmate]\ncommand = "old"\nargs = ["old.mjs"]\n\n# the other one, mine\n[mcp_servers.other]\ncommand = "other" # mine\nargs = ["a\n\n\nb"]\n'.replace(/\n/g, '\r\n').replace('a\r\n\r\n\r\nb', 'a\\n\\n\\nb');
  fs.writeFileSync(codex, tomlBefore);
  const cli = path.join(instance, 'cli.mjs'), node = process.execPath;
  const registration = createClientRegistration({ instanceRoot: instance, cli, node, platform: 'win32', env, home });
  for (const client of CLIENTS) assert.equal(registration.add(client).added, true);
  const launcher = path.join(instance, 'clients', 'devmate-mcp.mjs');
  // Claude Code: a user server, as "claude mcp add --scope user" writes it; everything else of the file as it was.
  const claudeSettings = JSON.parse(fs.readFileSync(claude, 'utf8'));
  assert.deepEqual(claudeSettings.mcpServers.devmate, { type: 'stdio', command: node, args: [launcher], env: {} });
  assert.deepEqual([claudeSettings.numStartups, claudeSettings.mcpServers.other, claudeSettings.projects], [7, { type: 'stdio', command: 'other' }, { a: { x: 1 } }]);
  // Codex: its table where the older one stood, with time for a runtime to start and the owner's variables a runtime
  // needs named to it; every other line of the file as it was, its line endings, and the comment of the next table.
  const toml = fs.readFileSync(codex, 'utf8');
  const table = '[mcp_servers.devmate]\r\ncommand = ' + JSON.stringify(node) + '\r\nargs = [' + JSON.stringify(launcher) + ']\r\nstartup_timeout_sec = 60\r\ntool_timeout_sec = 120\r\nenv_vars = [';
  assert.ok(toml.startsWith('# my settings\r\nmodel = "gpt"\r\n\r\n' + table), toml);
  assert.match(toml, /env_vars = \[[^\]]*"CODEX_HOME"[^\]]*"HTTPS_PROXY"[^\]]*\]\r\n\r\n# the other one, mine\r\n\[mcp_servers\.other\]\r\ncommand = "other" # mine\r\nargs = \["a\\n\\n\\nb"\]\r\n$/);
  assert.equal((toml.match(/\[mcp_servers\.devmate/g) || []).length, 1, toml); assert.doesNotMatch(toml, /old\.mjs/); assert.doesNotMatch(toml.replace(/\r\n/g, ''), /\n/, 'no line ending of another kind');
  // Claude Desktop: its mcpServers.
  assert.deepEqual(JSON.parse(fs.readFileSync(desktop, 'utf8')).mcpServers.devmate, { command: node, args: [launcher] });
  assert.deepEqual(registration.status().clients.map(item => [item.client, item.registered, item.stale, item.elsewhere]), CLIENTS.map(client => [client, true, undefined, undefined]));
  // Taken out again: DevMate's entries go, the owner's stay.
  for (const client of CLIENTS) assert.equal(registration.remove(client).removed, true);
  assert.equal(registration.remove('codex').removed, false, 'nothing to take out twice');
  assert.equal(JSON.parse(fs.readFileSync(claude, 'utf8')).mcpServers.devmate, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(claude, 'utf8')).mcpServers.other, { type: 'stdio', command: 'other' });
  assert.equal(fs.readFileSync(codex, 'utf8'), '# my settings\r\nmodel = "gpt"\r\n\r\n# the other one, mine\r\n[mcp_servers.other]\r\ncommand = "other" # mine\r\nargs = ["a\\n\\n\\nb"]\r\n', 'what is left is the file as it was without devmate');
  assert.deepEqual(registration.status().clients.map(item => item.registered), [false, false, false]);
  assert.throws(() => registration.add('cursor'), { code: 'invalid_input' });
});

test('a settings file DevMate cannot read is left as it is, and a registration of another instance or a Node that is gone is said as that', t => {
  const { home, instance, env } = place(t);
  const claude = clientFile('claude-code', { home, env });
  fs.writeFileSync(claude, '{ "mcpServers": { broken');
  const registration = createClientRegistration({ instanceRoot: instance, cli: path.join(instance, 'cli.mjs'), platform: 'win32', env, home });
  assert.throws(() => registration.add('claude-code'), { code: 'invalid_settings' });
  assert.equal(fs.readFileSync(claude, 'utf8'), '{ "mcpServers": { broken', 'not written over');
  assert.match(registration.status().clients[0].problem, /is not JSON DevMate can read/);
  fs.writeFileSync(claude, JSON.stringify({ mcpServers: { devmate: { command: process.execPath, args: [path.join(home, 'another-instance', 'clients', 'devmate-mcp.mjs')] } } }));
  assert.deepEqual(registration.status().clients[0], { client: 'claude-code', file: claude, registered: false, elsewhere: true });
  registration.add('claude-code');
  const settings = JSON.parse(fs.readFileSync(claude, 'utf8'));
  settings.mcpServers.devmate.command = path.join(home, 'node-that-was-removed.exe');
  fs.writeFileSync(claude, JSON.stringify(settings));
  assert.deepEqual(registration.status().clients[0], { client: 'claude-code', file: claude, registered: true, stale: true });
});

test('a config.toml DevMate cannot edit safely is left as it is: devmate defined another way, a multi-line string, a value over several lines', t => {
  const { home, instance, env } = place(t);
  const codex = clientFile('codex', { home, env }), registration = createClientRegistration({ instanceRoot: instance, cli: path.join(instance, 'cli.mjs'), platform: 'win32', env, home });
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  for (const [why, text] of [
    ['an inline table', '[mcp_servers]\ndevmate = { command = "x" }\n'],
    ['a dotted key', 'mcp_servers.devmate.command = "x"\n'],
    ['a quoted header', '[mcp_servers.\'devmate\']\ncommand = "x"\n'],
    ['a subtable', '[mcp_servers.devmate]\ncommand = "x"\n[mcp_servers.devmate.env]\nX = "1"\n'],
    ['a multi-line string', 'note = """\n[mcp_servers.devmate]\n"""\n'],
    ['a multi-line string with no devmate in it', 'note = \'\'\'\n[not.a.table]\n\'\'\'\n'],
    ['a value over several lines', '[mcp_servers.devmate]\nargs = [\n  "a",\n]\n'],
    ['two tables', '[mcp_servers.devmate]\ncommand = "x"\n[mcp_servers.devmate]\ncommand = "y"\n']]) {
    fs.writeFileSync(codex, text);
    for (const action of ['add', 'remove']) assert.throws(() => registration[action]('codex'), { code: 'invalid_settings' }, why + ': ' + action);
    assert.equal(fs.readFileSync(codex, 'utf8'), text, why + ': left as it is');
    assert.match(registration.status().clients[1].problem, /left as it is/, why);
  }
});

test('DevMate takes out only what it wrote for this instance, says when it replaced something else, and finds the settings where the client keeps them', t => {
  const { home, instance, env } = place(t);
  const claude = clientFile('claude-code', { home, env }), registration = createClientRegistration({ instanceRoot: instance, cli: path.join(instance, 'cli.mjs'), platform: 'win32', env, home });
  // An entry the owner wrote by hand (as the README shows it), or one of another instance, is not taken out.
  const hand = { mcpServers: { devmate: { type: 'http', url: 'http://127.0.0.1:8788/mcp' } } };
  fs.writeFileSync(claude, JSON.stringify(hand));
  assert.deepEqual(registration.remove('claude-code'), { client: 'claude-code', file: claude, removed: false, elsewhere: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(claude, 'utf8')), hand);
  // Added all the same where the owner asks for it, and said so.
  assert.match(registration.add('claude-code').replaced, /not this DevMate/);
  // The same launcher written in another case is this instance's on Windows.
  const settings = JSON.parse(fs.readFileSync(claude, 'utf8'));
  settings.mcpServers.devmate.args = [settings.mcpServers.devmate.args[0].toUpperCase()]; fs.writeFileSync(claude, JSON.stringify(settings));
  assert.equal(registration.status().clients[0].registered, true);
  // Where Claude Code keeps its settings elsewhere (CLAUDE_CONFIG_DIR), and where Claude Desktop is an app package.
  assert.equal(clientFile('claude-code', { home, env: { CLAUDE_CONFIG_DIR: path.join(home, 'claude-config') } }), path.join(home, 'claude-config', '.claude.json'));
  const packaged = path.join(home, 'local', 'Packages', 'Claude_pzs8sxrjxfjjc');
  fs.mkdirSync(packaged, { recursive: true });
  assert.equal(clientFile('claude-desktop', { platform: 'win32', home, env: { ...env, LOCALAPPDATA: path.join(home, 'local') } }), path.join(packaged, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  // The bridge in the instance directory taken away: said as unable to start, and written again by the next start.
  fs.rmSync(path.join(instance, 'clients'), { recursive: true });
  assert.equal(registration.status().clients[0].stale, true);
  fs.writeFileSync(path.join(instance, 'cli.mjs'), '');
  assert.equal(registration.refresh().refreshed, true);
  assert.equal(fs.existsSync(registration.launcher), true); assert.equal(registration.status().clients[0].stale, undefined);
});

test('what a client starts runs DevMate\'s stdio bridge for this instance with the copy of DevMate a start of the runtime wrote down', t => {
  const { root, home, instance, env } = place(t);
  // A stand-in for DevMate's command line: it says what it was asked to do.
  const said = path.join(root, 'said.json'), first = path.join(root, 'first', 'cli.mjs'), second = path.join(root, 'second', 'cli.mjs');
  for (const cli of [first, second]) {
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, 'import fs from "node:fs";\nexport async function main(argv) { fs.writeFileSync(' + JSON.stringify(said) + ', JSON.stringify({ argv, cli: ' + JSON.stringify(cli) + ' })); return 0; }\n');
  }
  const registration = createClientRegistration({ instanceRoot: instance, cli: first, platform: 'win32', env, home });
  // A start of the runtime writes nothing where no client was added.
  assert.equal(registration.refresh().refreshed, false); assert.equal(fs.existsSync(path.join(instance, 'clients')), false);
  registration.add('codex');
  const run = () => { const result = spawnSync(process.execPath, [registration.launcher], { encoding: 'utf8', timeout: 30000 }); assert.equal(result.status, 0, result.stderr); return JSON.parse(fs.readFileSync(said, 'utf8')); };
  assert.deepEqual(run(), { argv: ['mcp', '--instance', instance], cli: first });
  // An update: the runtime now runs another copy of DevMate, and its start says so to the bridge. The client's
  // settings are not touched for it.
  const before = fs.readFileSync(clientFile('codex', { home, env }), 'utf8');
  assert.equal(createClientRegistration({ instanceRoot: instance, cli: second, platform: 'win32', env, home }).refresh().refreshed, true);
  assert.deepEqual(run(), { argv: ['mcp', '--instance', instance], cli: second });
  assert.equal(fs.readFileSync(clientFile('codex', { home, env }), 'utf8'), before);
  // A copy of DevMate that is not there is not written down.
  assert.equal(createClientRegistration({ instanceRoot: instance, cli: path.join(root, 'gone', 'cli.mjs'), platform: 'win32', env, home }).refresh().refreshed, false);
  assert.deepEqual(run().cli, second);
});

test('devmate client add and remove are the owner\'s at this computer; a connected client may only look', async t => {
  const { home, instance } = place(t);
  // (A home of its own, as everywhere here: the owner's real settings are not even read. And no mark of a client that
  // the environment this test runs in may carry.)
  const own = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== CLIENT_COMMAND_ENV));
  const run = async (args, env = {}) => { const stdout = output(), stderr = output(); return { code: await main(['client', ...args, '--instance', instance], { stdout, stderr, env: { ...own, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'), ...env } }), stdout: stdout.text, stderr: stderr.text }; };
  for (const args of [['add', 'codex'], ['remove', 'codex']]) {
    const refused = await run(args, { [CLIENT_COMMAND_ENV]: '1' });
    assert.equal(refused.code, 1); assert.match(refused.stderr, /is run by the owner in their own terminal/);
  }
  const looked = await run([], { [CLIENT_COMMAND_ENV]: '1' });
  assert.equal(looked.code, 0, looked.stderr); assert.match(looked.stdout, /claude-desktop/);
  assert.ok(looked.stdout.includes(JSON.stringify(path.join(home, '.claude.json')).slice(1, -1)), 'the settings of this home, not the owner\'s');
  const unnamed = await run(['add']);
  assert.equal(unnamed.code, 1); assert.match(unnamed.stderr, /Name the client/);
});
