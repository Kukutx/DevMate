#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRuntimeClient, instanceDirectory } from './client.mjs';
import { runtimeLogTail, runtimeStatus, startRuntime, stopRuntime } from './launcher.mjs';
import { inspectTunnelClient, TUNNEL_CLIENT_SETUP } from './connection.mjs';
import { findOnPath, installHint, recallTools, resolveTool } from './platform/tools.mjs';
import { isProgram } from './platform/entry.mjs';
import { VERSION } from './version.mjs';

export const CLI_HELP = `DevMate ${VERSION} — gives AI clients real access to the projects on this computer.
Works on its own: no editor is required.

Runtime
  devmate start [--port <port>]     start the background runtime, or join the one already running
  devmate stop                      stop it
  devmate restart                   stop and start, applying saved settings
  devmate status                    whether it runs, its ports and process
  devmate serve [--port <port>]     run in the foreground until Ctrl+C
  devmate doctor                    check everything DevMate needs and say what to fix
  devmate logs [--lines <n>]        newest runtime log lines

Projects
  devmate project add [<directory>] [--name <name>] [--read-only]
  devmate project list
  devmate project remove <id | directory | name>

Connecting an AI client
  devmate mcp-url                   the address to enter in ChatGPT, Claude or another MCP client
  devmate mcp                       serve MCP on standard input and output, for clients that start
                                    their servers as a program; starts the runtime when needed
  devmate connect local
  devmate connect cloudflare --url https://<host>/mcp --executable <cloudflared> [--auth oauth]
  devmate connect openai-tunnel --tunnel-id <tunnel_…> --executable <tunnel-client>
  devmate connect https --url https://<host>/mcp [--auth oauth]
  devmate connect ssh --url https://<host>/mcp --host <server> --user <name> --executable <ssh>
  devmate secret set <NAME>         store a connection credential, read from standard input
  devmate secret list | remove <NAME>
  devmate login-code                one-time sign-in code for a client (OAuth mode)
  devmate ui [--open]               one-time link to the workbench in your browser

Everything the runtime can do
  devmate operations                list every operation
  devmate help <operation>          one operation with its exact input schema
  devmate <operation> [--json <object> | --file <input.json> | --stdin]
  devmate call <operation> [--json <object> | --file <input.json> | --stdin]
  devmate snapshot
  devmate events                    follow the event stream

Options: --instance <directory> selects another runtime instance, --timeout <ms>.
`;

const VALUE_OPTIONS = new Set(['instance', 'port', 'timeout', 'json', 'file', 'executable', 'name', 'url', 'tunnel-id', 'auth', 'lines',
  'host', 'user', 'member']);
const FLAG_OPTIONS = new Set(['stdin', 'help', 'open', 'read-only', 'version']);

export function parseCli(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    if (!word.startsWith('--')) { positional.push(word); continue; }
    const name = word.slice(2);
    if (FLAG_OPTIONS.has(name)) { options[name] = true; continue; }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: ${word}`);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: ${word}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value: ${word}`);
    options[name] = value;
  }
  const inputCount = ['json', 'file', 'stdin'].filter(name => Object.hasOwn(options, name)).length;
  if (inputCount > 1) throw new Error('Choose one input source: --json, --file, or --stdin');
  return { command: options.help ? 'help' : options.version ? 'version' : (positional.shift() || 'help'), positional, options };
}

async function readAll(stream, limit, label) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error(label + ' must be at most ' + Math.round(limit / 1048576) + ' MiB');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readCliInput(options, inputStream = process.stdin) {
  // A file write may carry 4 MB of text; the limit leaves room for its JSON escaping.
  const limit = 8 * 1024 * 1024;
  let raw = options.json;
  if (options.file) {
    const stat = fs.statSync(options.file);
    if (!stat.isFile() || stat.size > limit) throw new Error('Input file must be at most 8 MiB');
    raw = fs.readFileSync(options.file, 'utf8');
  }
  if (options.stdin) raw = await readAll(inputStream, limit, 'Standard input');
  if (raw === undefined) return {};
  if (Buffer.byteLength(raw, 'utf8') > limit) throw new Error('JSON input must be at most 8 MiB');
  let value;
  // PowerShell writes a byte order mark into piped and redirected text.
  try { value = JSON.parse(raw.replace(/^\ufeff/, '')); }
  catch { throw new Error('Input must contain valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Input must be a JSON object');
  return value;
}

export function publicOutput(value) {
  if (Array.isArray(value)) return value.map(publicOutput);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /^(?:ownerToken|authorization|password|secret|apiKey|runtimeKey|accessToken|refreshToken)$/i.test(key)
      ? '[redacted]' : publicOutput(item)
  ]));
}

// A credential is typed or piped, never passed as an argument: arguments end up in shell history and process lists.
async function readSecret(stdin, stderr, name) {
  if (!stdin.isTTY) return (await readAll(stdin, 65536, 'A credential')).replace(/^\ufeff/, '').trim();
  stderr.write('Value for ' + name + ' (input is hidden): ');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error, result) => {
      stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stderr.write('\n');
      error ? reject(error) : resolve(result);
    };
    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') return finish(null, value.trim());
        if (character === '\u0003') return finish(new Error('Cancelled'));
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else value += character;
      }
    };
    stdin.setRawMode(true); stdin.resume(); stdin.on('data', onData);
  });
}

function openInBrowser(url, spawnImpl = spawn) {
  const [file, args] = process.platform === 'win32'
    ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['/usr/bin/open', [url]] : [findOnPath('xdg-open') || 'xdg-open', [url]];
  const child = spawnImpl(file, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
  child.once('error', () => {});
  child.unref();
}

// What can be checked while no runtime is running, so the first thing a new user sees is the way forward.
async function offlineDoctor(instanceRoot) {
  const checks = [];
  const check = (id, status, detail, fix) => checks.push({ id, status, detail, ...(fix ? { fix } : {}) });
  const major = Number(process.versions.node.split('.')[0]);
  check('node', major >= 24 ? 'ok' : 'fail', 'Node.js ' + process.versions.node, major >= 24 ? null : 'Install Node.js 24 or newer.');
  recallTools(instanceRoot);
  for (const [tool, purpose] of [['rg', 'file find and search'], ['git', 'the Git tools']]) {
    let found = null, problem = null;
    try { found = resolveTool(tool); } catch (error) { if (error.code === 'tool_outdated') problem = error.message; }
    if (problem) check(tool, 'fail', problem, purpose[0].toUpperCase() + purpose.slice(1) + ' do not work until it is updated.');
    else check(tool, found ? 'ok' : 'fail', found ? found + (findOnPath(tool) ? '' : ' (the copy that ships with your editor)') : tool + ' is not on PATH; it is required for ' + purpose, found ? null : installHint(tool));
  }
  try {
    const { readConfig, publicMcpUrl } = await import('./config.mjs');
    const config = readConfig(instanceRoot), url = publicMcpUrl(config);
    check('settings', 'ok', 'connection: ' + config.connection.kind + ', auth: ' + config.auth.mode + (url ? ', public URL: ' + url : ''));
    if (config.connection.executable) check('connection.executable', fs.statSync(config.connection.executable, { throwIfNoEntry: false })?.isFile() ? 'ok' : 'fail',
      config.connection.executable, 'Install the connector and set its absolute path with devmate connect.');
  } catch (error) { check('settings', 'fail', 'config.json is not valid: ' + error.message, 'Fix or delete ' + path.join(instanceRoot, 'config.json') + '.'); }
  check('runtime', 'warn', 'The runtime is not running, so projects, the connection and agents were not checked.', 'Start it with: devmate start');
  return { version: VERSION, status: checks.some(item => item.status === 'fail') ? 'fail' : 'warn', checks };
}

async function configureConnection(kind, options, instanceRoot) {
  const { readConfig, saveConfig, publicMcpUrl } = await import('./config.mjs');
  const need = name => { if (!options[name]) throw new Error('connect ' + kind + ' needs --' + name); return options[name]; };
  const executable = () => path.resolve(need('executable'));
  const connection = kind === 'local' ? { kind: 'local' }
    : kind === 'cloudflare' ? { kind, publicUrl: need('url'), executable: executable() }
    : kind === 'openai-tunnel' ? { kind, tunnelId: need('tunnel-id'), executable: executable() }
    : kind === 'https' ? { kind: 'external-https', url: need('url') }
    : kind === 'ssh' ? { kind, publicUrl: need('url'), executable: executable(), host: need('host'), user: need('user') }
    : null;
  if (!connection) throw new Error('Choose one of: connect local, cloudflare, openai-tunnel, https, ssh');
  if (options.auth && !['none', 'oauth'].includes(options.auth)) throw new Error('--auth is none or oauth');
  fs.mkdirSync(instanceRoot, { recursive: true, mode: 0o700 });
  const current = readConfig(instanceRoot);
  const next = { ...current, connection };
  const url = publicMcpUrl(next);
  // Sign-in belongs to a public URL. Keep the chosen mode when the URL stays; never keep an issuer for another origin.
  if (options.auth === 'oauth') {
    if (!url) throw new Error('--auth oauth needs a connection with a public URL (cloudflare, https or ssh)');
    next.auth = { mode: 'oauth', issuer: new URL(url).origin, ...(current.auth.mode === 'oauth' && current.auth.clients ? { clients: current.auth.clients } : {}) };
  } else if (options.auth === 'none' || !url || (current.auth.mode === 'oauth' && current.auth.issuer !== new URL(url).origin)) next.auth = { mode: 'none' };
  const saved = saveConfig(instanceRoot, next);
  const credential = saved.connection.tokenEnv || saved.connection.runtimeKeyEnv || null;
  return { saved: { connection: saved.connection, auth: saved.auth }, credential,
    next: [credential ? 'Store the credential: devmate secret set ' + credential : null, 'Apply it: devmate restart', 'Then check: devmate doctor'].filter(Boolean) };
}

export async function main(argv = process.argv.slice(2), {
  stdout = process.stdout, stderr = process.stderr, stdin = process.stdin,
  clientFactory = createRuntimeClient,
  launch = startRuntime, stop = stopRuntime, status = runtimeStatus,
  inspect = inspectTunnelClient, open = openInBrowser
} = {}) {
  const print = value => stdout.write(`${JSON.stringify(publicOutput(value), null, 2)}\n`);
  try {
    const { command, positional, options } = parseCli(argv);
    const runtimeOptions = {
      ...(options.instance ? { instanceRoot: path.resolve(options.instance) } : {}),
      ...(options.port ? { port: Number(options.port) } : {}),
      ...(options.timeout ? { timeoutMs: Number(options.timeout) } : {})
    };
    const instanceRoot = instanceDirectory(runtimeOptions.instanceRoot);
    const callOptions = options.timeout ? { timeoutMs: Number(options.timeout) } : {};
    if (command === 'help' && !positional.length) { stdout.write(CLI_HELP); return 0; }
    if (command === 'version') { stdout.write(VERSION + '\n'); return 0; }
    if (command === 'start') { print(await launch(runtimeOptions)); return 0; }
    if (command === 'stop') { print(await stop(runtimeOptions)); return 0; }
    if (command === 'restart') {
      await stop(runtimeOptions);
      print(await launch(runtimeOptions));
      return 0;
    }
    if (command === 'status') { print(await status(runtimeOptions)); return 0; }
    if (command === 'serve') {
      const { serve } = await import('./main.mjs');
      const runtime = await serve({ ...(runtimeOptions.instanceRoot ? { instanceRoot } : {}), ...(options.port ? { port: Number(options.port) } : {}) });
      stderr.write('DevMate is running on http://127.0.0.1:' + runtime.port + ' — press Ctrl+C to stop.\n');
      while (runtime.health.status !== 'stopped') await new Promise(resolve => setTimeout(resolve, 250));
      return 0;
    }
    if (command === 'mcp') {
      // Standard output belongs to the protocol from here on: nothing else may be written to it.
      const { serveStdioBridge } = await import('./stdio-bridge.mjs');
      const note = line => stderr.write('devmate mcp: ' + line + '\n');
      const connect = async () => {
        const current = await status(runtimeOptions);
        if (!current.running) { note('starting the runtime'); await launch(runtimeOptions); }
        return clientFactory(runtimeOptions).origin() + '/mcp';
      };
      await connect();
      const bridge = await serveStdioBridge({ connect, stdin, stdout, log: note });
      await bridge.closed;
      return 0;
    }
    if (command === 'logs') {
      const lines = runtimeLogTail(instanceRoot, { bytes: 64000 }).split(/\r?\n/);
      stdout.write(lines.slice(-Math.max(1, Number(options.lines) || 40)).join('\n') + '\n');
      return 0;
    }
    if (command === 'connect') { print(await configureConnection(positional[0], options, instanceRoot)); return 0; }
    if (command === 'connection') {
      const action = positional[0] || 'info';
      if (action === 'info') { print(TUNNEL_CLIENT_SETUP); return 0; }
      if (action === 'inspect') { print(await inspect({ executable: options.executable })); return 0; }
      throw new Error('Use connection info or connection inspect; change the connection with devmate connect');
    }
    if (command === 'secret') {
      // Credentials live in the instance directory, so they can be stored before the runtime ever starts.
      const { createSecretStore } = await import('./secrets.mjs');
      fs.mkdirSync(instanceRoot, { recursive: true, mode: 0o700 });
      const secrets = createSecretStore(instanceRoot), [action, name] = positional;
      if (action === 'list') { print({ names: secrets.names() }); return 0; }
      if (action === 'remove' && name) { print(secrets.remove(name)); return 0; }
      if (action === 'set' && name) { print(secrets.set(name, await readSecret(stdin, stderr, name))); return 0; }
      throw new Error('Use secret set <NAME>, secret list or secret remove <NAME>');
    }
    const client = clientFactory(runtimeOptions);
    if (command === 'doctor') {
      let report;
      try { report = await client.call('runtime.doctor', {}, { timeoutMs: 60000 }); }
      catch (error) { if (error.code !== 'RUNTIME_STOPPED') throw error; report = await offlineDoctor(instanceRoot); }
      const mark = { ok: '[ ok ]', info: '[info]', warn: '[warn]', fail: '[FAIL]' };
      for (const item of report.checks) {
        stdout.write(`${mark[item.status]} ${item.id}: ${item.detail}\n`);
        if (item.fix && item.status !== 'ok') stdout.write(`       -> ${item.fix}\n`);
      }
      stdout.write(`\nDevMate ${report.version}: ${report.status === 'ok' ? 'everything needed is in place.' : report.status === 'warn' ? 'working, with warnings above.' : 'not fully working; fix the FAIL items above.'}\n`);
      return report.status === 'fail' ? 1 : 0;
    }
    if (command === 'project') {
      const [action, target] = positional;
      if (action === 'list') { print((await client.call('project.list', {}, callOptions)).items.map(({ id, name, root, access }) => ({ id, name, root, access }))); return 0; }
      if (action === 'add') {
        print(await client.call('project.create', { root: path.resolve(target || '.'), ...(options.name ? { name: options.name } : {}),
          ...(options['read-only'] ? { access: 'read' } : {}) }, callOptions));
        return 0;
      }
      if (action === 'remove' && target) {
        const items = (await client.call('project.list', {}, callOptions)).items;
        // Projects are stored under their real path; a link or an alias of the same directory names the same project.
        let real = path.resolve(target);
        try { real = fs.realpathSync.native(real); } catch {}
        const wanted = process.platform === 'win32' ? real.toLowerCase() : real;
        const matches = items.filter(item => item.id === target || item.name === target || (process.platform === 'win32' ? item.root.toLowerCase() : item.root) === wanted);
        if (matches.length !== 1) throw new Error(matches.length ? 'Several projects match; use the project id' : 'No registered project matches: ' + target);
        print(await client.call('project.remove', { id: matches[0].id }, callOptions));
        return 0;
      }
      throw new Error('Use project add [<directory>], project list or project remove <id | directory | name>');
    }
    if (command === 'mcp-url') {
      const connection = await client.call('connection.status', {}, callOptions);
      const local = client.origin() + '/mcp';
      const remote = connection.tunnelId || connection.publicUrl || connection.url;
      stdout.write((remote || local) + '\n');
      stderr.write(connection.tunnelId ? 'In ChatGPT choose the Tunnel connection type and enter this tunnel ID. Clients on this computer use ' + local + '\n'
        : remote ? 'Clients on this computer can also use ' + local + '\n'
        : 'This address works only on this computer. Cloud clients such as ChatGPT need: devmate connect\n');
      return 0;
    }
    if (command === 'login-code') {
      const issued = await client.call('auth.code.create', options.member ? { memberId: options.member } : {}, callOptions);
      stdout.write(issued.code + '\n');
      stderr.write('Enter this code on the DevMate authorization page. It works once and expires at ' + issued.expiresAt + '.\n');
      return 0;
    }
    if (command === 'snapshot') { print(await client.snapshot()); return 0; }
    if (command === 'ui') {
      const url = await client.signInUrl();
      stdout.write(url + '\n');
      if (options.open) open(url);
      else stderr.write('Open this link in your browser within a minute; it works once. --open does it for you.\n');
      return 0;
    }
    if (command === 'operations' || command === 'help') {
      if (command === 'help') {
        const operation = (await client.call('operations.list', { name: positional[0] })).items[0];
        if (!operation) throw new Error(`Unknown operation: ${positional[0]}`);
        print(operation);
      } else print(await client.operations());
      return 0;
    }
    if (command === 'events') {
      const abort = new AbortController();
      const interrupt = () => abort.abort();
      process.once('SIGINT', interrupt);
      try { for await (const event of client.events({ signal: abort.signal })) print(event); }
      catch (error) { if (!abort.signal.aborted) throw error; }
      finally { process.off('SIGINT', interrupt); }
      return 0;
    }
    const operation = command === 'call' ? positional[0] : command;
    if (!operation || (command === 'call' ? positional.length !== 1 : positional.length !== 0)) throw new Error('Use call <operation> with one operation name');
    if (!operation.includes('.')) throw new Error('Unknown command: ' + operation + '. Run devmate help for the commands, or devmate operations for every operation.');
    print(await client.call(operation, await readCliInput(options, stdin), callOptions));
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: { code: error.code || 'CLI_ERROR', message: error.message } })}\n`);
    return 1;
  }
}

if (isProgram(import.meta.url, 'cli.mjs')) process.exitCode = await main();
