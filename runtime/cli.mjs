#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { CLIENT_COMMAND_ENV, createRuntimeClient, instanceDirectory } from './client.mjs';
import { runtimeLogTail, runtimeStatus, startRuntime, stopRuntime } from './launcher.mjs';
import { inspectTunnelClient, TUNNEL_CLIENT_SETUP } from './connection.mjs';
import { findCloudflared, findOnPath, installHint, recallTools, resolveTool, startable } from './platform/tools.mjs';
import { isProgram } from './platform/entry.mjs';
import { VERSION, newerVersion } from './version.mjs';

export const CLI_HELP = `DevMate ${VERSION} — gives AI clients real access to the projects on this computer.
Works on its own: no editor is required.

Runtime
  devmate start [--port <port>]     start the background runtime, or join the one already running
  devmate stop                      stop it
  devmate restart                   stop and start, applying saved settings
  devmate status                    whether it runs, its ports and process
  devmate serve [--port <port>]     run in the foreground until Ctrl+C
  devmate doctor                    check everything DevMate needs and say what to fix
  devmate doctor --report           the same with usage and the last log lines, private paths, addresses
                                    and credentials taken out: for a bug report
  devmate logs [--lines <n>]        newest runtime log lines

Browser
  devmate chrome install            let the DevMate extension in Chrome and Edge reach this runtime: bookmarks,
                                    tabs, history, downloads and the page in front become available to your
                                    client, and the extension can start DevMate with the browser
  devmate chrome                    whether a browser is registered and connected
  devmate chrome uninstall          take the registration away again

Projects
  devmate project add [<directory>] [--name <name>] [--read-only]
  devmate project list
  devmate project remove <id | directory | name>
  devmate access [guarded | full]   what a connected client may decide: guarded (default) keeps sharing,
                                    credential files and agent approvals with you at this computer;
                                    full hands them to your client and approves agents automatically
  devmate delegation [ask | allow | off]
                                    whether a connected client may hand tasks to Codex, Claude Code and the
                                    other agents here, which run on your account with them: ask (default) has
                                    you allow each task at this computer, in either access profile, and starts
                                    no process for a task before that (a copy of the project a client asked
                                    for is made before, and removed when you say no); allow runs them without
                                    asking, those that wait included; off refuses them and ends what waits

Connecting an AI client
  devmate mcp-url                   the address to enter in ChatGPT, Claude or another MCP client
  devmate mcp                       serve MCP on standard input and output, for clients that start
                                    their servers as a program; starts the runtime when needed
  devmate connect local
  devmate connect quick             a Cloudflare quick tunnel: no account, no domain, nothing to set up;
                                    the address changes whenever it starts again
  devmate connect cloudflare --url https://<host>/mcp --executable <cloudflared> [--auth oauth]
  devmate connect openai-tunnel --tunnel-id <tunnel_…> [--organization <org-…>]
                                    OpenAI's own tunnel, for ChatGPT: outbound only, no public address, an id
                                    that stays. DevMate speaks it itself; --executable <tunnel-client> uses
                                    OpenAI's program instead. --organization names the tunnel's organization,
                                    for a key OpenAI wants it named with (the doctor says when)
  devmate connect https --url https://<host>/mcp [--auth oauth]
  devmate connect ssh --url https://<host>/mcp --host <server> --user <name> --executable <ssh>
                                    [--ssh-port <n>] [--identity <key file>]
  devmate connect quick | cloudflare | https | ssh … --openai-tunnel <tunnel_…> [--organization <org-…>]
                                    OpenAI's tunnel beside that connection, both at once: ChatGPT of the account
                                    the tunnel belongs to comes through the tunnel, every other client through
                                    the address. Without the option the connection is set up alone
  devmate connect beside --openai-tunnel <tunnel_…> | none [--organization <org-…>]
                                    the same for the connection there is, a relay included, which stays as it
                                    is and is not named again: puts the tunnel beside it, or with none takes
                                    it away. The tunnel that is there, named again, keeps its organization
  devmate relay setup <user@host> [--domain <name>] [--ssh-port <n>] [--identity <key file>] [--any-address]
                                    make a public Linux server of yours the way in: an address that stays,
                                    with nothing of a third party in between. Installs Caddy there over SSH
                                    (key login, root or sudo), forwards one unguessable path to this computer,
                                    and answers only ChatGPT, Claude and this computer unless --any-address
  devmate relay remove <user@host>  take the relay off that server again
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

const VALUE_OPTIONS = new Set(['instance', 'port', 'timeout', 'json', 'file', 'executable', 'name', 'url', 'tunnel-id', 'openai-tunnel', 'organization', 'auth', 'lines',
  'host', 'user', 'domain', 'ssh-port', 'identity']);
const FLAG_OPTIONS = new Set(['stdin', 'help', 'open', 'read-only', 'version', 'report', 'any-address']);

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

export async function readCliInput(options, inputStream = process.stdin, platform = process.platform) {
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
  catch {
    // Windows PowerShell 5.1 and cmd hand a program its argument without the double quotes that were inside it, so
    // JSON written after --json arrives as {name:value}. What PowerShell 5.1 pipes to a program it writes as ASCII.
    // Which shell it was typed in is not known here (PowerShell 7 and Git Bash keep the quotes), and the JSON may
    // simply be wrong: said as what may be the matter, with the way that works in any of them.
    throw new Error('Input must contain valid JSON' + (platform === 'win32' && options.json !== undefined && !options.file && !options.stdin
      ? '. If the JSON itself is right and this was typed in Windows PowerShell 5.1 or cmd: they take the double quotes out of what follows --json. Write the input into a file and pass --file <input.json>. (--stdin works for plain ASCII; PowerShell 5.1 turns other letters it pipes into question marks.)' : ''));
  }
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

// The runtime keeps serving the program it was started from. After an update this command is newer than what runs,
// until the runtime is started again. Said wherever the difference would otherwise show as something else: a start
// that "attached", a doctor that finds everything in place, a new command the runtime has never heard of.
function olderRuntime(current) {
  const running = current?.running ? current.record?.version : null;
  // (Or the folder it was started from was removed by an update while it ran: what it starts from there fails.)
  if (running && current.health?.filesGone) return { detail: 'The folder the running DevMate was started from is not there any more: an update removed it. It still answers, but tasks for coding agents and the browser\'s connection fail.', fix: 'Start it again: devmate restart' };
  return running && newerVersion(VERSION, running)
    ? { detail: 'DevMate ' + running + ' is still running, older than this command (' + VERSION + ').', fix: 'Run the new one: devmate restart' } : null;
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
    // What the doctor prints gets pasted into bug reports. The last part of a relay's address is its key.
    check('settings', 'ok', 'connection: ' + config.connection.kind + (config.openaiTunnel ? ' with OpenAI\'s tunnel beside it' : '') + ', auth: ' + config.auth.mode + (url ? ', public URL: ' + url.replace(/\/mcp\/[A-Za-z0-9_-]{20,}$/, '/mcp/<key>') : ''));
    if (config.connection.executable) check('connection.executable', startable(config.connection.executable) ? 'ok' : 'fail',
      config.connection.executable, 'Install the connector and set its absolute path with devmate connect.');
  } catch (error) { check('settings', 'fail', 'config.json is not valid: ' + error.message, 'Fix or delete ' + path.join(instanceRoot, 'config.json') + '.'); }
  check('runtime', 'warn', 'The runtime is not running, so projects, the connection and agents were not checked.', 'Start it with: devmate start');
  return { version: VERSION, status: checks.some(item => item.status === 'fail') ? 'fail' : 'warn', checks };
}

async function configureConnection(kind, options, instanceRoot) {
  const { readConfig, saveConfig, publicMcpUrl } = await import('./config.mjs');
  const need = name => { if (!options[name]) throw new Error('connect ' + kind + ' needs --' + name); return options[name]; };
  const executable = () => path.resolve(need('executable'));
  // The quick tunnel needs nothing but cloudflared, which is looked for when it is not named.
  const cloudflared = () => {
    const found = options.executable ? executable() : findCloudflared();
    if (!found) throw new Error('cloudflared is not on this computer. Install it (Windows: winget install Cloudflare.cloudflared; macOS: brew install cloudflared; Linux: the cloudflared package), or name it with --executable');
    return found;
  };
  // beside: the connection there is stays as it is and is not named again (the address of a relay is nothing its owner
  // ever typed); only OpenAI's tunnel beside it is added, changed or taken away.
  const staying = kind === 'beside', stays = staying ? readConfig(instanceRoot) : null;
  const connection = staying ? stays.connection : kind === 'local' ? { kind: 'local' }
    : kind === 'quick' ? { kind: 'cloudflare-quick', executable: cloudflared() }
    : kind === 'cloudflare' ? { kind, publicUrl: need('url'), executable: executable() }
    : kind === 'openai-tunnel' ? { kind, tunnelId: need('tunnel-id'), ...(options.executable ? { executable: executable() } : {}), ...(options.organization ? { organizationId: options.organization } : {}) }
    : kind === 'https' ? { kind: 'external-https', url: need('url') }
    // The port and the key file of the login are part of an SSH connection: left out of what is saved, the connection
    // logged in on port 22 without the key, whatever the command had said.
    : kind === 'ssh' ? { kind, publicUrl: need('url'), executable: executable(), host: need('host'), user: need('user'),
      ...(options['ssh-port'] ? { sshPort: Number(options['ssh-port']) } : {}), ...(options.identity ? { identityFile: path.resolve(options.identity) } : {}) }
    : null;
  if (!connection) throw new Error('Choose one of: connect local, quick, cloudflare, openai-tunnel, https, ssh, beside');
  // What names a connection and says nothing for this kind is not passed over in silence: a command that was accepted
  // would be taken to have done what it said.
  const NAMING = ['url', 'host', 'user', 'executable', 'tunnel-id', 'ssh-port', 'identity', 'domain', 'any-address'];
  const takes = { local: [], quick: ['executable'], cloudflare: ['url', 'executable'], 'openai-tunnel': ['tunnel-id', 'executable'], https: ['url'], ssh: ['url', 'executable', 'host', 'user', 'ssh-port', 'identity'], beside: [] }[kind];
  const stray = NAMING.filter(name => options[name] !== undefined && !takes.includes(name));
  if (stray.length && !staying) throw new Error('connect ' + kind + ' does not take ' + stray.map(name => '--' + name).join(', ') + (takes.length ? ': of the options that name a connection it takes ' + takes.map(name => '--' + name).join(', ') : ': it takes no option that names a connection') +
    (stray.some(name => ['domain', 'any-address'].includes(name)) ? '. --domain and --any-address belong to a relay: devmate relay setup <user@host>' : '') + '.');
  if (options.auth && !['none', 'oauth'].includes(options.auth)) throw new Error('--auth is none or oauth');
  // OpenAI's tunnel beside a connection that has an address. With no such connection the tunnel is the connection.
  const beside = options['openai-tunnel'] === 'none' ? null : options['openai-tunnel'];
  // The organization is said of a tunnel: where none is named it would be taken and dropped.
  if (options.organization !== undefined && !staying && kind !== 'openai-tunnel' && !beside)
    throw new Error('--organization names the OpenAI organization of a tunnel, and connect ' + kind + ' names no tunnel here. Give it with the tunnel: --openai-tunnel <tunnel_…> --organization <org-…>' + (kind === 'local' ? ' on a connection that has an address, or devmate connect openai-tunnel --tunnel-id <tunnel_…> --organization <org-…>' : '') + '.');
  if (staying) {
    if (!options['openai-tunnel']) throw new Error('connect beside needs --openai-tunnel <tunnel_…>, or --openai-tunnel none to take the tunnel away');
    if (options.auth) throw new Error('connect beside changes the tunnel alone. Sign-in belongs to the address and is chosen with it: devmate connect … --auth ' + options.auth);
    // What names a connection says nothing here, and is not passed over in silence.
    if (stray.length) throw new Error('connect beside leaves the connection as it is and takes only --openai-tunnel and --organization (given: ' + stray.map(name => '--' + name).join(', ') +
      '). To set the connection up anew: devmate connect quick | cloudflare | https | ssh …');
    if (!beside && options.organization) throw new Error('--openai-tunnel none takes the tunnel away: --organization says nothing of a tunnel that is no longer there');
    if (connection.kind === 'openai-tunnel') throw new Error('OpenAI\'s tunnel ' + connection.tunnelId + ' is the connection itself here: there is no address for a tunnel to be beside. Set the address up with the tunnel named (devmate connect quick | cloudflare | https | ssh … --openai-tunnel ' + connection.tunnelId +
      '), or a relay first (devmate relay setup <user@host>) and the tunnel beside it after that (devmate connect beside --openai-tunnel ' + connection.tunnelId + ')');
    if (connection.kind === 'local') throw new Error(beside ? 'There is no connection with a public address to put the tunnel beside. On its own the tunnel is: devmate connect openai-tunnel --tunnel-id ' + beside : 'The connection is local: no tunnel runs beside it.');
    if (!beside && !stays.openaiTunnel) throw new Error('No OpenAI tunnel runs beside this connection.');
  } else if (beside && ['local', 'openai-tunnel'].includes(connection.kind)) throw new Error('--openai-tunnel puts OpenAI\'s tunnel beside a connection that has a public address (quick, cloudflare, https or ssh). On its own the tunnel is: devmate connect openai-tunnel --tunnel-id ' + beside);
  fs.mkdirSync(instanceRoot, { recursive: true, mode: 0o700 });
  const { openaiTunnel: besideBefore, ...current } = readConfig(instanceRoot);
  // The tunnel this instance spoke until now, beside a connection or as the connection.
  const before = besideBefore || (current.connection.kind === 'openai-tunnel' && !current.connection.executable ? current.connection : null);
  // The tunnel that is named again keeps what was set for it (its organization, and what the settings file gives it:
  // the name of its key, how many calls at once). Another tunnel starts with nothing of the one before.
  // (Whoever carried it until now: also where it was the connection and OpenAI's own program ran it.)
  const carried = besideBefore || (current.connection.kind === 'openai-tunnel' ? current.connection : null);
  const same = beside && carried?.tunnelId === beside ? Object.fromEntries(['organizationId', 'runtimeKeyEnv', 'maxConcurrentRequests'].filter(name => carried[name] !== undefined).map(name => [name, carried[name]])) : {};
  const next = { ...current, connection, ...(beside ? { openaiTunnel: { ...same, tunnelId: beside, ...(options.organization ? { organizationId: options.organization } : {}) } } : {}) };
  const url = publicMcpUrl(next);
  // Sign-in belongs to a public URL. Keep the chosen mode when the URL stays; never keep an issuer for another origin.
  if (options.auth === 'oauth') {
    if (!url) throw new Error('--auth oauth needs a connection with a public URL that stays the same (cloudflare, https or ssh)');
    next.auth = { mode: 'oauth', issuer: new URL(url).origin, ...(current.auth.mode === 'oauth' && current.auth.clients ? { clients: current.auth.clients } : {}) };
  } else if (options.auth === 'none' || !url || (current.auth.mode === 'oauth' && current.auth.issuer !== new URL(url).origin)) next.auth = { mode: 'none' };
  const saved = saveConfig(instanceRoot, next);
  // The connection that stays keeps its credential: only the tunnel's is spoken of.
  const credential = staying ? null : saved.connection.tokenEnv || saved.connection.runtimeKeyEnv || null, tunnelKey = saved.openaiTunnel?.runtimeKeyEnv || null;
  // Which tunnel a stored key was made for cannot be seen from here. What is said holds either way: one that is
  // stored is named, with what to do if it is another tunnel's.
  const { createSecretStore } = await import('./secrets.mjs');
  const stored = name => { try { return createSecretStore(instanceRoot).has(name); } catch { return false; } };
  const store = (name, what, other) => !name ? null : stored(name) ? name + ' is stored already and will be used. If it is ' + other + ', store this one\'s: devmate secret set ' + name
    : 'Store ' + what + ': devmate secret set ' + name;
  // A tunnel that is taken away is said, with the way to have it again.
  const lost = before && !saved.openaiTunnel && saved.connection.kind !== 'openai-tunnel' ? 'OpenAI\'s tunnel ' + before.tunnelId + ' is no longer used. ' : null;
  // So is a relay that this command put another connection in the place of. It is not changed by naming its address
  // on an SSH connection: that is a connection of another kind, without what makes a relay work.
  // The commands it names are the ones that reach that relay: with the port, the key file and the name it was set up
  // with, which a command without them would not use (it would log in on port 22 without the key, and set up a relay
  // under the server's bare address).
  const relayed = current.connection.relay && !staying ? current.connection : null, relay = relayed ? relayed.user + '@' + relayed.host : null;
  // So with the program, where it is not the one a plain command finds: a relay that was set up with --executable,
  // because OpenSSH is not on the PATH, is not reached by a command that leaves it out.
  const reach = relayed ? (relayed.sshPort && relayed.sshPort !== 22 ? ' --ssh-port ' + relayed.sshPort : '') + (relayed.identityFile ? ' --identity "' + relayed.identityFile + '"' : '') +
    (relayed.executable && relayed.executable !== findOnPath('ssh') ? ' --executable "' + relayed.executable + '"' : '') : '';
  // A relay that answers under a name was set up with that name, also where it is the server's own: setup asks for it.
  const named = relayed && !isIP(new URL(relayed.publicUrl).hostname) ? ' --domain ' + new URL(relayed.publicUrl).hostname : '';
  // commands: lines for the owner to type, written as they are. Inside the answer they would be printed as JSON, with
  // every quote and every backslash of a Windows path doubled up, which is not a command any more.
  return { ...(relay ? { commands: ['To make that server the relay again (its address is then a new one, which the client has to be given: devmate mcp-url):', '  devmate relay setup ' + relay + named + reach,
    'If it was set up with --any-address, add that: without it the relay answers only ChatGPT, Claude and this computer.', 'To take the relay off that server:', '  devmate relay remove ' + relay + reach] } : {}),
    saved: { connection: staying ? { kind: saved.connection.kind, ...(saved.connection.relay ? { relay: true } : {}) } : saved.connection, auth: saved.auth, ...(saved.openaiTunnel ? { openaiTunnel: saved.openaiTunnel } : {}) }, credential,
    next: [store(credential, 'the credential', 'the credential of another tunnel'), store(tunnelKey, 'the runtime key of the tunnel', 'the runtime key of another tunnel'), 'Apply it: devmate restart', 'Then check: devmate doctor',
      saved.connection.kind === 'cloudflare-quick' ? 'The address for your client: devmate mcp-url (it changes each time DevMate or the tunnel starts again)' : null,
      // Sign-in is asked where a sign-in page can be reached: at the address. Nothing asks for it on the tunnel's way.
      saved.openaiTunnel && saved.auth.mode === 'oauth' ? 'Sign-in is asked at the address only. What comes through OpenAI\'s tunnel is taken as yours without it: who may use the tunnel is decided in the OpenAI account it belongs to.' : null,
      lost && saved.connection.kind !== 'local' ? lost + 'To run it beside this connection: devmate connect beside --openai-tunnel ' + before.tunnelId + (before.organizationId ? ' --organization ' + before.organizationId : '')
        : lost && besideBefore ? lost + 'On its own it is: devmate connect openai-tunnel --tunnel-id ' + before.tunnelId : null,
      relay ? 'The relay on ' + current.connection.host + ' was the connection until now, and this command put another in its place' +
        (saved.connection.kind === 'ssh' ? ': a plain SSH connection, without the relay\'s own ports and key file and without telling the relay the address of this computer' : '') +
        '. The relay stays installed on that server. The commands that make it the relay again, and that take it off the server, are printed below this answer as they are typed' +
        '. To put OpenAI\'s tunnel beside a relay, leave the relay as it is and run: devmate connect beside --openai-tunnel <tunnel id>' : null].filter(Boolean) };
}

// What the extension shows in place of "connection lost" where the host turns its browser away (see main).
const BROWSER_OF_A_CLIENT = 'DevMate does not serve this browser: it was opened by a command that a connected client or a coding agent ran, and carries that command\'s mark, so what it asks is not taken as yours. ' +
  'Close the browser completely (every window, and its icon beside the clock if it keeps one) and open it yourself: the extension then connects again.';

// What this command line writes is read in the owner's terminal, and carries words that are not DevMate's: the name
// a client gave a project, the operation it asked for, what a program or a server said, a line of the log. A terminal
// acts on control characters (it moves the cursor, wipes a line, makes a link of other words), and characters that
// turn a line around change what is read. So every such character is written as what it is called (its number),
// except the line end and the tab: no text can take a line of this output away or put another in its place.
export const legible = text => String(text).replace(/(?![\n\t])[\p{Cc}\p{Bidi_Control}]/gu, one => '\\u' + one.codePointAt(0).toString(16).padStart(4, '0'));
// One entry of a list on one line: words from elsewhere do not begin a line of their own beside DevMate's.
const oneLine = text => String(text).replace(/\s*[\r\n]+\s*/g, ' ');

export async function main(argv = process.argv.slice(2), {
  stdout = process.stdout, stderr = process.stderr, stdin = process.stdin,
  clientFactory = createRuntimeClient,
  launch = startRuntime, stop = stopRuntime, status = runtimeStatus,
  inspect = inspectTunnelClient, open = openInBrowser, env = process.env,
  setup = options => import('./relay.mjs').then(relay => relay.setupRelay(options)), remove = options => import('./relay.mjs').then(relay => relay.removeRelay(options)),
  browserHost = options => import('./platform/chrome-registration.mjs').then(module => module.createChromeRegistration(options))
} = {}) {
  const print = value => stdout.write(`${JSON.stringify(publicOutput(value), null, 2)}\n`);
  // Started by a browser for the DevMate extension: its standard output carries the browser's own framing and nothing
  // else, and its arguments are the browser's (the extension that asks, a window handle), not this command line's.
  // What it is answered is the owner's at this computer. A browser never carries the mark of a command that a
  // connected client started (its shell tool, or an agent it delegated to); one that does is that client's.
  // A browser that such a command opened carries the mark too, and so does every host it starts: the owner's own
  // browser would then be turned away without a word, since a browser throws away what a host writes to its error
  // output and says only that the host has ended. So the host says why in the one message the extension shows as it
  // is, answers nothing else, and ends.
  if (argv[0] === 'chrome-host' && env[CLIENT_COMMAND_ENV] === '1') {
    stderr.write('devmate chrome-host is started by the browser for the DevMate extension, not through a connected client\n');
    stdout.write((await import('./chrome-host.mjs')).frame({ type: 'refused', message: BROWSER_OF_A_CLIENT }));
    return 2;
  }
  if (argv[0] === 'chrome-host') return (await import('./chrome-host.mjs')).chromeHostMain(argv.slice(1), { stdin, stdout, stderr });
  // From here on everything is written for a person to read (legible), also what is printed as JSON, where the
  // characters JSON leaves as they are (DEL, the second set of control characters, those that turn a line) are
  // written by their numbers too. The one exception is the stream a protocol is spoken on (devmate mcp).
  const wire = stdout, read = stream => ({ write: text => stream.write(typeof text === 'string' ? legible(text) : text) });
  stdout = read(stdout); stderr = read(stderr);
  let running = async () => null;
  try {
    const { command, positional, options } = parseCli(argv);
    // Started by a connected client (its shell tool, or an agent it delegated to): the runtime then answers as it
    // would answer that client, and what only the owner at this computer does is not done from here.
    const viaClient = env[CLIENT_COMMAND_ENV] === '1';
    if (viaClient && ['stop', 'restart', 'connect', 'relay', 'secret', 'serve'].includes(command))
      throw new Error('devmate ' + command + ' is run by the owner in their own terminal, not through a connected client');
    const runtimeOptions = {
      ...(options.instance ? { instanceRoot: path.resolve(options.instance) } : {}),
      ...(options.port ? { port: Number(options.port) } : {}),
      ...(options.timeout ? { timeoutMs: Number(options.timeout) } : {}),
      ...(viaClient ? { viaClient } : {})
    };
    const instanceRoot = instanceDirectory(runtimeOptions.instanceRoot);
    const callOptions = options.timeout ? { timeoutMs: Number(options.timeout) } : {};
    running = () => status(runtimeOptions);
    const older = current => { const stale = olderRuntime(current); if (stale) stderr.write(stale.detail + ' ' + stale.fix + '\n'); return current; };
    if (command === 'help' && !positional.length) { stdout.write(CLI_HELP); return 0; }
    if (command === 'version') { stdout.write(VERSION + '\n'); return 0; }
    if (command === 'start') { const started = await launch(runtimeOptions); print(started); older(started); return 0; }
    if (command === 'stop') { print(await stop(runtimeOptions)); return 0; }
    if (command === 'restart') {
      // A port the owner chose for the runtime stays its port: one that is not named again is the one that ran.
      const before = options.port ? null : await status(runtimeOptions).catch(() => null);
      await stop(runtimeOptions);
      print(await launch({ ...runtimeOptions, ...(before?.running && Number.isInteger(before.record?.port) ? { port: before.record.port } : {}) }));
      return 0;
    }
    if (command === 'status') { const current = await status(runtimeOptions); print(current); older(current); return 0; }
    if (command === 'serve') {
      // The runtime runs in this process and writes lines of its own straight to the process's output: a fault with
      // the path that was asked for, what a connector's program or a server said. In this terminal they are held to
      // what everything else here is (legible), for as long as it runs.
      const streams = [process.stdout, process.stderr].map(stream => ({ stream, write: stream.write }));
      for (const { stream, write } of streams) stream.write = (chunk, ...rest) => write.call(stream, typeof chunk === 'string' ? legible(chunk) : chunk, ...rest);
      try {
        const { serve } = await import('./main.mjs');
        const runtime = await serve({ ...(runtimeOptions.instanceRoot ? { instanceRoot } : {}), ...(options.port ? { port: Number(options.port) } : {}) });
        stderr.write('DevMate is running on http://127.0.0.1:' + runtime.port + ' — press Ctrl+C to stop.\n');
        while (runtime.health.status !== 'stopped') await new Promise(resolve => setTimeout(resolve, 250));
        return 0;
      } finally { for (const { stream, write } of streams) stream.write = write; }
    }
    if (command === 'mcp') {
      // Standard output belongs to the protocol from here on: nothing else may be written to it.
      const { serveStdioBridge } = await import('./stdio-bridge.mjs');
      const note = line => stderr.write('devmate mcp: ' + line + '\n');
      const connect = async () => {
        const current = await status(runtimeOptions), stale = olderRuntime(current);
        if (!current.running) { note('starting the runtime'); await launch(runtimeOptions); }
        if (stale) note(stale.detail + ' ' + stale.fix);
        return clientFactory(runtimeOptions).origin() + '/mcp';
      };
      await connect();
      const bridge = await serveStdioBridge({ connect, stdin, stdout: wire, log: note });
      await bridge.closed;
      return 0;
    }
    if (command === 'logs') {
      const lines = runtimeLogTail(instanceRoot, { bytes: 64000 }).split(/\r?\n/);
      stdout.write(lines.slice(-Math.max(1, Number(options.lines) || 40)).join('\n') + '\n');
      return 0;
    }
    if (command === 'chrome') {
      const action = positional[0] || 'status';
      if (!['install', 'uninstall', 'status'].includes(action)) throw new Error('Use chrome install, chrome uninstall, or chrome alone to see how the browser is connected');
      // Which program a browser may start for the extension is set at this computer, by its owner.
      if (viaClient && action !== 'status') throw new Error('devmate chrome ' + action + ' is run by the owner in their own terminal, not through a connected client');
      const registration = await browserHost({ instanceRoot, cli: fileURLToPath(import.meta.url), env });
      const state = action === 'install' ? await registration.install() : action === 'uninstall' ? await registration.uninstall() : await registration.status();
      // Where the extension is, for a browser that does not have it yet: the copy the registration keeps in the
      // instance directory, which stays where it is when DevMate is updated.
      const folder = state.folder || null;
      let connected = null;
      if (action !== 'uninstall') { try { connected = await clientFactory(runtimeOptions).call('chrome.status', {}, { timeoutMs: 5000 }); } catch { connected = null; } }
      print({ ...state, ...(connected ? { browser: connected } : {}),
        next: action === 'uninstall' ? ['Remove the DevMate extension in the browser too (chrome://extensions).']
          : [state.unseen ? 'A registration is there that no browser can see: it was written from inside an app that Windows gives a registry of its own. Register again, which now writes where browsers read: devmate chrome install'
            : !state.registered ? 'Register DevMate with Chrome and Edge: devmate chrome install' : null,
            state.stale ? 'It was registered with a Node or a copy of DevMate that is gone. Register again: devmate chrome install' : null,
            state.registered && !connected?.connected ? 'In the browser open chrome://extensions (Edge: edge://extensions), switch on "Developer mode", choose "Load unpacked" and pick ' + (folder || 'the chrome-extension folder of DevMate') +
              '. Leave Developer mode on: the extension loads itself again when DevMate is updated.' : null,
            connected?.connected ? 'Connected. A model reaches the browser through capability_list {engine:"chrome"}.' : null].filter(Boolean) });
      return 0;
    }
    if (command === 'connect') {
      const { commands, ...answer } = await configureConnection(positional[0], options, instanceRoot);
      print(answer);
      if (commands) stderr.write(commands.join('\n') + '\n');
      return 0;
    }
    if (command === 'relay') {
      const [action, target] = positional;
      if (!['setup', 'remove'].includes(action) || !target) throw new Error('Use relay setup <user@host> [--domain <name>], or relay remove <user@host>');
      // Said before anything is done on the server: an option that is not taken is not passed over in silence.
      if (options['openai-tunnel']) throw new Error('relay ' + action + ' does not take --openai-tunnel. ' + (action === 'remove' ? 'A tunnel that ran beside the relay is the connection once the relay is gone.'
        : 'A tunnel that runs beside the connection stays beside the relay; to add one, set the relay up and then: devmate connect beside --openai-tunnel ' + options['openai-tunnel']));
      const { relayTarget } = await import('./relay.mjs');
      const ssh = options.executable ? path.resolve(options.executable) : findOnPath('ssh');
      if (!ssh) throw new Error('OpenSSH is not on this computer. Windows has it as an optional feature (OpenSSH Client); or name the program with --executable');
      const sshPort = options['ssh-port'] ? Number(options['ssh-port']) : 22;
      const login = { target, sshPort, executable: ssh, ...(options.identity ? { identityFile: path.resolve(options.identity) } : {}) };
      const { readConfig, saveConfig } = await import('./config.mjs');
      fs.mkdirSync(instanceRoot, { recursive: true, mode: 0o700 });
      const current = readConfig(instanceRoot), mine = current.connection.kind === 'ssh' && current.connection.relay === true && current.connection.host === relayTarget(target).host;
      if (action === 'remove') {
        const removed = await remove(login);
        // A relay that is gone is no longer how this computer is reached. A tunnel that ran beside it is, from now on alone.
        if (mine) saveConfig(instanceRoot, { ...current, connection: current.openaiTunnel ? { kind: 'openai-tunnel', ...current.openaiTunnel } : { kind: 'local' }, auth: { mode: 'none' } });
        print({ ...removed, ...(mine ? { next: ['This computer no longer uses it: devmate restart'] } : {}) });
        return 0;
      }
      // Setting the same server up again keeps its address: the same key under the same name.
      const relay = await setup({ ...login, domain: options.domain, allowList: !options['any-address'],
        ...(mine && (!options.domain || new URL(current.connection.publicUrl).hostname === options.domain) ? { key: new URL(current.connection.publicUrl).pathname.split('/')[2] } : {}) });
      saveConfig(instanceRoot, { ...current, connection: { ...relay.connection, relay: true }, auth: { mode: 'none' } });
      // The relay takes the place of the connection. A tunnel that ran beside the connection runs beside the relay; one
      // that was the connection is no longer used, which is said with the way to have it beside the relay.
      const alone = current.connection.kind === 'openai-tunnel' && !current.connection.executable ? current.connection : null;
      print({ relay: 'https://' + relay.site + '/mcp/<key>', server: relay.user + '@' + relay.host,
        answers: relay.allowList ? 'ChatGPT, Claude and this computer, under the one path' : 'whoever has the whole address',
        ...(current.openaiTunnel ? { openaiTunnel: current.openaiTunnel.tunnelId + ' stays beside it' } : {}),
        said: relay.notes, next: ['Apply it: devmate restart', 'Check it: devmate doctor', 'The address for your client, which stays the same from now on: devmate mcp-url',
          alone ? 'OpenAI\'s tunnel ' + alone.tunnelId + ' is no longer used. To run it beside the relay: devmate connect beside --openai-tunnel ' + alone.tunnelId + (alone.organizationId ? ' --organization ' + alone.organizationId : '') : null].filter(Boolean) });
      return 0;
    }
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
    if (command === 'doctor' && options.report) {
      let text;
      try { text = (await client.call('runtime.report', {}, { timeoutMs: 60000 })).text; }
      catch (error) {
        if (error.code !== 'RUNTIME_STOPPED') throw error;
        text = (await import('./report.mjs')).offlineReport(instanceRoot, await offlineDoctor(instanceRoot));
      }
      stdout.write(text + '\n');
      return 0;
    }
    if (command === 'doctor') {
      let report;
      try { report = await client.call('runtime.doctor', {}, { timeoutMs: 60000 }); }
      catch (error) { if (error.code !== 'RUNTIME_STOPPED') throw error; report = await offlineDoctor(instanceRoot); }
      // The report is the running runtime's, and so is the version in its last line.
      const stale = olderRuntime({ running: true, record: report });
      if (stale) report = { ...report, status: report.status === 'ok' ? 'warn' : report.status, checks: [...report.checks, { id: 'runtime.version', status: 'warn', ...stale }] };
      const mark = { ok: '[ ok ]', info: '[info]', warn: '[warn]', fail: '[FAIL]' };
      for (const item of report.checks) {
        stdout.write(`${mark[item.status]} ${item.id}: ${oneLine(item.detail)}\n`);
        if (item.fix && item.status !== 'ok') stdout.write(`       -> ${oneLine(item.fix)}\n`);
      }
      stdout.write(`\nDevMate ${report.version}: ${report.status === 'ok' ? 'everything needed is in place.' : report.status === 'warn' ? 'working, with warnings above.' : 'not fully working; fix the FAIL items above.'}\n`);
      return report.status === 'fail' ? 1 : 0;
    }
    if (command === 'project') {
      const [action, target] = positional;
      if (action === 'list') { print((await client.call('project.list', {}, callOptions)).items.map(({ id, name, root, access, missing }) => ({ id, name, root, access, ...(missing ? { missing: true } : {}) }))); return 0; }
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
    if (command === 'access') {
      const [profile] = positional;
      if (profile !== undefined && !['guarded', 'full'].includes(profile)) throw new Error('Use access, access guarded or access full');
      const chosen = profile ? await client.call('access.update', { profile }, callOptions) : await client.call('access.read', {}, callOptions);
      stdout.write(chosen.profile + '\n');
      stderr.write(chosen.profile === 'full'
        ? 'Full access: a client connected as the owner can share folders, read credential files, set up engines and answer agents; what a delegated agent asks permission for is granted automatically. Back to the default: devmate access guarded\n'
        : 'Guarded: you share folders, lift credential-file protection and answer agents at this computer. To hand all of that to your connected client: devmate access full\n');
      return 0;
    }
    if (command === 'delegation') {
      const [mode] = positional;
      if (mode !== undefined && !['ask', 'allow', 'off'].includes(mode)) throw new Error('Use delegation, delegation ask, delegation allow or delegation off');
      const chosen = mode ? await client.call('delegation.update', { mode }, callOptions) : await client.call('delegation.read', {}, callOptions);
      stdout.write(chosen.mode + '\n');
      // What choosing it did is said where it was chosen just now, with what it did to the tasks there were; a look
      // at the choice changes nothing and says nothing of that.
      const tasks = count => count + (count === 1 ? ' task' : ' tasks');
      const did = !mode ? '' : chosen.mode === 'ask' ? ' From now on every agent is asked about again, also one whose later tasks you had let through' +
          (chosen.again ? ', and ' + tasks(chosen.again) + ' of a client that had been let through and had not begun wait' + (chosen.again === 1 ? 's' : '') + ' for your answer again' : '') + '.' +
          (chosen.ended ? ' ' + chosen.ended + ' more ' + (chosen.ended === 1 ? 'task of a client that had not begun was' : 'tasks of a client that had not begun were') + ' ended: as many as may wait for your answer at once did already.' : '')
        : chosen.mode === 'allow' ? (chosen.allowed ? ' ' + tasks(chosen.allowed) + ' that waited for your answer ' + (chosen.allowed === 1 ? 'was' : 'were') + ' let through.' : '') +
          (chosen.waiting ? ' ' + tasks(chosen.waiting) + ' still wait' + (chosen.waiting === 1 ? 's' : '') + ': something else keeps ' + (chosen.waiting === 1 ? 'it' : 'them') + ' from beginning (no session is free, or the workflow is paused or has no turns left; the workbench says which, devmate ui), and ' +
            (chosen.waiting === 1 ? 'it is' : 'they are') + ' let through when that is out of the way.' : '')
        : ' What waited for your answer or its turn was ended.';
      stderr.write({ ask: 'Ask: a task that a connected client hands to Codex, Claude Code or another agent here waits until you allow it at this computer, in the workbench (devmate ui) or your editor. What you start here yourself is not asked about.' + did + ' Not to be asked: devmate delegation allow\n',
        allow: 'Allow: a connected client hands tasks to the coding agents here without asking you; each runs on your account with the provider.' + did + ' To be asked first: devmate delegation ask\n',
        off: 'Off: a connected client cannot hand tasks to the coding agents here; you still can, at this computer.' + did + ' To be asked for each task instead: devmate delegation ask\n' }[chosen.mode]);
      return 0;
    }
    if (command === 'mcp-url') {
      const connection = await client.call('connection.status', {}, callOptions);
      const local = client.origin() + '/mcp';
      const remote = connection.tunnelId || connection.publicUrl || connection.url;
      // A quick tunnel without an address has nothing a client in the cloud could use, and the local address is not it.
      if (connection.kind === 'cloudflare-quick' && !remote) {
        stderr.write('The quick tunnel has not been given its address yet. Try again in a few seconds; devmate doctor shows what the tunnel says. Clients on this computer use ' + local + '\n');
        return 1;
      }
      stdout.write((remote || local) + '\n');
      stderr.write(connection.tunnelId ? 'In ChatGPT choose the Tunnel connection type and enter this tunnel ID. Clients on this computer use ' + local + '\n'
        : remote ? (connection.temporaryAddress ? 'This address ends in the key of this start: give it to your own client only. ' : '') +
            (connection.remoteMcpVerified === false ? 'It has not been checked end to end yet (devmate doctor). ' : '') +
            // The address serves every client; the tunnel beside it serves ChatGPT of the account it belongs to.
            (connection.openaiTunnel?.tunnelId ? 'ChatGPT of the account the tunnel belongs to can use the Tunnel connection type instead, with the tunnel ID ' + connection.openaiTunnel.tunnelId + '. ' : '') +
            'Clients on this computer can also use ' + local + '\n'
        : 'This address works only on this computer. Cloud clients such as ChatGPT need: devmate connect\n');
      return 0;
    }
    if (command === 'login-code') {
      const issued = await client.call('auth.code.create', {}, callOptions);
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
    // A runtime that was started before an update has never heard of what the update brought.
    const stale = error.code === 'unknown_operation' ? olderRuntime(await running().catch(() => null)) : null;
    stderr.write(`${JSON.stringify({ ok: false, error: { code: error.code || 'CLI_ERROR', message: error.message + (stale ? '. ' + stale.detail + ' ' + stale.fix : '') } })}\n`);
    return 1;
  }
}

if (isProgram(import.meta.url, 'cli.mjs')) {
  const code = await main();
  // The program a browser starts ends when it is done, whatever it still holds open: the browser keeps its end of the
  // connection open for as long as this process lives, and a host that stayed would serve nobody.
  if (process.argv[2] === 'chrome-host') process.exit(code);
  process.exitCode = code;
}
