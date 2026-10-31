import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createChromeRegistration } from '../platform/chrome-registration.mjs';
import { createClientRegistration } from '../platform/client-registration.mjs';
import { SWITCH_OFF } from '../desktop.mjs';
import { findOnPath, installHint, resolveTool, startable } from '../platform/tools.mjs';
import { VERSION } from '../version.mjs';
import { TUNNEL_HELP } from '../openai-tunnel.mjs';
import { TAKING_OFF_THE_LIST } from '../workspace.mjs';
import { named, within } from './shared.mjs';

/**
 * One list of everything that decides whether this installation works, each
 * with the concrete next step. Nothing here starts a model request.
 */
export async function doctor(service) {
  const checks = [];
  // Each entry is one line, wherever it is shown (a terminal, an editor's output, a side panel, a report): words
  // from elsewhere in it, a name or what a program said, do not begin a line of their own beside DevMate's.
  const oneLine = text => String(text).replace(/\s*[\r\n]+\s*/g, ' ');
  const check = (id, status, detail, fix) => checks.push({ id, status, detail: oneLine(detail), ...(fix ? { fix: oneLine(fix) } : {}) });
  const major = Number(process.versions.node.split('.')[0]);
  check('node', major >= 24 ? 'ok' : 'fail', 'Node.js ' + process.versions.node, major >= 24 ? null : 'Install Node.js 24 or newer.');
  // The folder this runtime was started from, taken away while it runs (an update of an editor's extension removes
  // the folder of the version before). It answers on from memory, and what it starts from there later fails.
  if (service.filesGone?.()) check('runtime.files', 'fail', 'The folder this runtime was started from is not there any more: an update removed it while the runtime ran. It still answers, but what it starts from that folder fails: tasks for coding agents, Claude Code\'s permission requests, the program a browser starts.',
    'Start it again, from what is installed now: devmate restart (or "Restart shared runtime" in the editor).');
  const shell = service.processes.shell;
  const present = startable(shell.file);
  check('shell', present ? 'ok' : 'fail', shell.label + ' at ' + shell.file, 'Commands cannot run without the system shell.');
  // The shell being there does not say that it runs anything. PowerShell is started with a script file, which a policy
  // of an organisation can forbid: asked by running the smallest command the way every command is run.
  if (present && shell.kind === 'powershell') {
    const tried = await service.processes.tryShell();
    if (!tried.ok) check('shell.run', 'fail', shell.label + ' did not run a one-line command: ' + tried.reason,
      /PSSecurityException|UnauthorizedAccess/.test(tried.reason)
        ? 'A policy on this computer forbids PowerShell to run scripts and overrides what DevMate asks for (Get-ExecutionPolicy -List shows where it is set). No command runs through DevMate until that policy allows scripts for your account.'
        : 'No command runs through DevMate until the shell does. If the message says that running scripts is disabled, a policy on this computer sets PowerShell\'s execution policy (Get-ExecutionPolicy -List shows where).');
  }
  // Models write `a && b` by habit. Windows PowerShell 5.1 does not have it; PowerShell 7 does.
  if (shell.label === 'Windows PowerShell 5.1') check('shell.version', 'info', 'Commands run in Windows PowerShell 5.1: it has no && and ||, which models write by habit, and every command pays about a third of a second for its start.',
    'Install PowerShell 7 with one command (winget install --id Microsoft.PowerShell --source winget) and restart DevMate: it is used automatically, accepts what models usually write and starts faster.');
  for (const [tool, purpose] of [['rg', 'file find and search'], ['git', 'Git tools']]) {
    let found = null, problem = null;
    try { found = resolveTool(tool); } catch (error) { if (error.code === 'tool_outdated') problem = error.message; }
    if (problem) check(tool, 'fail', problem, 'The ' + purpose + ' do not work until it is updated.');
    else check(tool, found ? 'ok' : 'fail', found ? found + (findOnPath(tool) ? '' : ' (the copy that ships with your editor)') : tool + ' is not on PATH; it is required for ' + purpose, found ? null : installHint(tool));
  }
  // File modes mean nothing on Windows: there, privacy of the instance comes from living in the owner's own profile.
  if (process.platform === 'win32' && !within(os.homedir(), service.instanceRoot)) check('instance', 'warn', 'The instance directory ' + service.instanceRoot + ' is outside your user profile.',
    'Other accounts on this computer may be able to read its owner token and credentials. Keep the instance under ' + os.homedir() + ', or restrict the folder\'s permissions.');
  const projects = service.store.count('project');
  check('projects', projects ? 'ok' : 'warn', projects + ' project(s) registered', projects ? null : 'Register one with devmate project add, or share a folder from an editor that runs DevMate.');
  // A folder that was moved, renamed or deleted after it was shared stays on the list, and every call for it fails.
  // So does one on a drive that is not connected, for which the remedy is the opposite: nothing is to be removed.
  // Looked at now, all at once and without holding anything else up; only "nothing is at this path" counts. It is the
  // look the list of projects and the instructions answer from, so that the three say the same. A folder that has
  // not answered within the time such a look is given (a share that hangs) is named as that, instead of this report
  // not coming.
  const listed = service.store.list('project', { limit: 10000 }), places = found => found.slice(0, 8).map(project => named(project.name) + ' at ' + project.root).join('; ') + (found.length > 8 ? '; and ' + (found.length - 8) + ' more' : '');
  const silent = await service.lookAtFolders(listed), gone = listed.filter(project => service.folders.get(project.id)?.missing && !silent.includes(project));
  if (gone.length) check('projects.missing', 'warn', 'The folder of ' + gone.length + ' project(s) is not there: ' + places(gone),
    'Where the folder is on a drive or a share that is not connected right now, connect it: nothing has to be removed. Where it was moved, renamed or deleted, take the project off the list ' +
    '(devmate project remove <id, name or folder>) and share the folder where it is now (devmate project add <folder>). ' + TAKING_OFF_THE_LIST);
  // (Nothing is to be removed for it: a project that is taken off the list does not come back with the share.)
  if (silent.length) check('projects.unanswered', 'warn', 'The folder of ' + silent.length + ' project(s) has not answered when it was looked for: ' + places(silent),
    'That is a share or a drive that hangs. Connect it again, or wait for it: nothing has to be removed. Until it answers, calls for such a project wait for it as long as the system does.');
  const windows = service.windows.list().length;
  check('editor', windows ? 'ok' : 'info', windows + ' editor window(s) attached', windows ? null : 'Editor context needs VS Code or Obsidian with DevMate running; diagnostics come from VS Code.');
  for (const provider of (await service.discoverProviders()).items) {
    const installed = provider.status === 'installed', absent = provider.error?.code === 'agent_not_installed';
    // Not installed is a choice; installed but unusable (too old, broken) is something to fix.
    check('agent.' + provider.id, installed ? 'ok' : absent ? 'info' : 'warn',
      installed ? 'installed' + (provider.version ? ', version ' + provider.version : '') : absent ? 'not installed' : provider.error?.message || provider.status,
      installed ? null : absent ? 'Only needed to delegate tasks to ' + provider.id + '.' : 'Update or reinstall ' + provider.id + (provider.minimumVersion ? ' (version ' + provider.minimumVersion + ' or newer)' : '') + ' to delegate tasks to it.');
  }
  const connection = service.config.connection, url = service.publicUrl(), env = service.secrets.environment();
  // Whether a client in the cloud could reach this computer at all without something in between. An address that is
  // private, shared by a provider (100.64.0.0/10) or link-local is not reachable from outside, whatever is forwarded.
  const addresses = Object.values(os.networkInterfaces()).flat().filter(item => item && !item.internal);
  const privateV4 = address => /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address);
  const direct = addresses.some(item => (item.family === 'IPv4' || item.family === 4) && !privateV4(item.address));
  if (!direct && connection.kind === 'local') check('network', 'info', 'This computer has no public IPv4 address of its own: it is behind a router or a provider\'s address translation, so a client in the cloud cannot connect to it directly.',
    'Give it a way in that you control: a relay on a public server of yours (devmate relay setup user@host), or for ChatGPT OpenAI\'s own tunnel (devmate connect openai-tunnel).');
  // How the runtime's own requests leave this computer: OpenAI's tunnel service, the check of the public route, a
  // signing-in client's metadata document.
  const proxy = service.proxy?.current();
  if (proxy?.proxy) check('proxy', 'ok', 'Requests to the outside go through ' + proxy.proxy + ' (' + (proxy.source === 'environment' ? 'the HTTPS_PROXY / HTTP_PROXY variables' : 'the system proxy of this account') + ').');
  else if (proxy?.script) check('proxy', 'warn', 'This account uses a proxy script, which DevMate cannot run: its requests to the outside go directly and may not get through.', 'Give the proxy\'s address in the HTTPS_PROXY variable for DevMate, then restart it (devmate restart).');
  else if (proxy?.unsupported) check('proxy', 'warn', 'This computer is set to use a proxy that DevMate cannot use (' + proxy.unsupported + '): its requests to the outside go directly and may not get through.',
    /Node\.js/.test(proxy.unsupported) ? 'Install Node.js 24.14 or newer, then restart DevMate (devmate restart).' : 'Give an HTTP proxy address in the HTTPS_PROXY variable, then restart DevMate (devmate restart).');
  const status = await service.connectionState();
  // An OpenAI tunnel has no address to connect back through. What proves it is a call that arrived: the runtime counts them.
  const tunnelProof = (id, state, tunnelId) => {
    // Calls that came through prove the way as long as it is open: of a tunnel that is not connected now they are history.
    if (state.client === 'built-in' && state.served > 0) check(id, state.phase === 'connected' ? 'ok' : 'warn', 'OpenAI\'s tunnel has delivered ' + state.served + ' call(s) to this runtime, the last one at ' + state.lastCallAt +
      (state.phase === 'connected' ? '.' : '. It is not connected now (' + (state.phase || 'unknown') + '): nothing comes through it until it is.'));
    // Connected and never called: what is missing is on OpenAI's side, where a tunnel is tied to workspaces and roles.
    else if (state.client === 'built-in' && state.phase === 'connected') check(id, 'info', 'OpenAI accepts this runtime for ' + tunnelId + ' and is being asked for work; no call has come through it yet.',
      'In ChatGPT add a custom MCP server, choose Tunnel as its connection and pick or paste this tunnel id (devmate mcp-url prints it), then call any DevMate tool. ' +
      'If ChatGPT does not offer the tunnel, the cause is in the OpenAI account and not in DevMate, which is connected: the tunnel has to include the ChatGPT workspace you use, not only a Platform organization, and your account needs the Tunnels permissions Read and Use (' +
      TUNNEL_HELP.settings + '; "Troubleshooting" in ' + TUNNEL_HELP.guide + '). Whether your ChatGPT plan offers the Tunnel connection is decided by OpenAI.');
    else check(id, 'info', 'An OpenAI tunnel cannot be probed from here.', 'Call any DevMate tool from ChatGPT to confirm it.');
  };
  const credential = connection.kind === 'cloudflare' ? connection.tokenEnv : connection.kind === 'openai-tunnel' ? connection.runtimeKeyEnv : null;
  if (connection.kind === 'local') check('connection', 'info', 'Local only: http://127.0.0.1 clients can connect, cloud clients such as ChatGPT cannot.', 'For ChatGPT use OpenAI\'s own tunnel (devmate connect openai-tunnel --tunnel-id <id>); for any client a relay on a server of yours (devmate relay setup user@host).');
  else {
    if (connection.executable) check('connection.executable', startable(connection.executable) ? 'ok' : 'fail', connection.executable, 'Install the connector and set its absolute path in the connection settings.');
    if (credential) check('connection.credential', env[credential] ? 'ok' : 'fail', credential + (env[credential] ? ' is set' : ' is missing'),
      'Store it with: devmate secret set ' + credential + ' (or "Configure Connection" in the editor), then restart DevMate.');
    const phase = status.phase || status.status || 'unknown', fault = status.error?.message || service.connectionFault?.message;
    // What OpenSSH said last is the remedy of the line about the process, and a remedy is shown only where its line
    // is not in order: while ssh runs it would be pointed at and not be there. A line further down that needs it
    // therefore says it itself.
    const lastSaid = status.diagnostic ? ' What OpenSSH said last: ' + String(status.diagnostic).slice(-400).trim() : '';
    check('connection.process', ['connected', 'relay-ready', 'configured', 'process-running'].includes(phase) ? 'ok' : ['connecting', 'starting'].includes(phase) ? 'warn' : 'fail',
      connection.kind + ': ' + phase + (connection.kind === 'openai-tunnel' ? status.client === 'built-in' ? ' (spoken by DevMate itself, protocol ' + status.wireProtocol + ', up to ' + status.maxConcurrentRequests + ' calls at once)' : ' (OpenAI\'s tunnel-client program)' : '') +
        (fault ? ' — ' + fault : ''), status.diagnostic ? String(status.diagnostic).slice(-400) : fault ? 'Fix the cause, then restart DevMate (devmate restart, or "Restart" in the editor).' : null);
    if (url) {
      const verification = service.verification?.url === url ? service.verification : await service.verifyConnection();
      // What the doctor prints gets pasted into bug reports. The last part of a quick tunnel or relay address is its key.
      const shown = url.replace(/\/mcp\/[A-Za-z0-9_-]{20,}$/, '/mcp/<key>');
      // A name this computer's own DNS has not caught up with is not a broken route.
      // The check is made from this computer, through the public address. Where it gets no answer at all, that is
      // what is known: a client in the cloud comes another way and may still get through.
      const passOn = 'pass the public host name on (nginx: proxy_set_header Host $host; Apache: ProxyPreserveHost On)';
      check('connection.public', verification.verified ? 'ok' : verification.reachable || verification.pending ? 'warn' : 'fail',
        shown + (verification.verified ? ' reaches this runtime' : ' — ' + verification.reason + (verification.reachable || verification.pending ? '' : ' (asked from this computer; a client in the cloud may still get through: try it there)')),
        verification.verified ? null : connection.kind === 'cloudflare' ? 'In the Cloudflare dashboard, route the hostname to ' + (status.routeService || 'the ingress port') + '.'
          : connection.kind === 'cloudflare-quick' ? 'A quick tunnel comes and goes. For a new one, and with it a new address (devmate mcp-url): devmate connect quick --new-address, then devmate restart.'
          : connection.relay ? 'devmate restart opens the forward to the relay again.' + lastSaid
          : connection.kind === 'ssh' ? 'The web server on ' + connection.host + ' has to send this address on to 127.0.0.1:' + (connection.remotePort ?? 18443) + ' there and ' + passOn + '.' + lastSaid
          : 'Your proxy has to send this address on to the ingress port of this computer (ingressPort in devmate status) and ' + passOn + '.');
    } else if (connection.kind === 'cloudflare-quick') check('connection.public', 'warn', 'The quick tunnel has not been given an address yet.', 'Give it a few seconds and run the doctor again: what cloudflared said last is in the connection.process line above.');
    else tunnelProof('connection.public', status, connection.tunnelId);
    if (connection.kind === 'cloudflare-quick') check('connection.address', 'info', 'This is a quick tunnel, which Cloudflare offers for trying things out: no uptime guarantee, at most 200 requests at once, no event streams (DevMate answers through it in plain JSON, without progress messages). ' +
      (status.addressSince ? 'Its address has stayed the same since ' + status.addressSince + (status.adopted ? ', kept from before the last restart of DevMate' : '') + '. ' : '') +
      'The address stays across restarts and updates of DevMate. It changes after devmate stop, a runtime that ended on an error, a restart of the computer or a sign-out that ends your programs, a long time without a connection to Cloudflare, or devmate connect quick --new-address followed by devmate restart; the client then has to be given the new one (devmate mcp-url).',
      'For daily use take an address that stays: an OpenAI tunnel or a Cloudflare tunnel on a domain of yours ("Configure Connection" in the editor, or devmate connect).');
  }
  // OpenAI's tunnel beside that connection: a second way in, with a key and a state of its own.
  const beside = service.config.openaiTunnel, tunnel = beside ? await service.tunnelState() : null;
  if (tunnel) {
    check('tunnel.credential', env[beside.runtimeKeyEnv] ? 'ok' : 'fail', beside.runtimeKeyEnv + (env[beside.runtimeKeyEnv] ? ' is set' : ' is missing'),
      'Store it with: devmate secret set ' + beside.runtimeKeyEnv + ', then restart DevMate.');
    const phase = tunnel.phase || 'unknown', fault = tunnel.error?.message || service.tunnelFault?.message;
    check('tunnel.process', phase === 'connected' ? 'ok' : phase === 'connecting' ? 'warn' : 'fail',
      'OpenAI\'s tunnel beside it: ' + phase + (tunnel.client === 'built-in' ? ' (spoken by DevMate itself, protocol ' + tunnel.wireProtocol + ', up to ' + tunnel.maxConcurrentRequests + ' calls at once)' : '') + (fault ? ' — ' + fault : ''),
      fault ? 'Fix the cause, then restart DevMate (devmate restart, or "Restart" in the editor).' : null);
    tunnelProof('tunnel.public', tunnel, beside.tunnelId);
  }
  // What the runtime's own tunnel client hands over is served as the owner without sign-in, in either auth mode.
  const tunnelled = [status, tunnel].find(state => state?.kind === 'openai-tunnel' && state.client === 'built-in');
  // A quick tunnel cannot ask for sign-in. Its address ends in a key, and that key is what keeps strangers out: the
  // host name alone, which anyone watching DNS can see, opens nothing. The key stays until the owner makes a new one.
  if (url && connection.kind === 'cloudflare-quick') check('security', 'warn', 'The quick tunnel has no sign-in: its address ends in a random key that stays until you make a new one, and whoever has the whole address can read and change your projects and run commands.',
    'Give the address (devmate mcp-url) only to your own client, and do not paste it anywhere else. If it got out: devmate connect quick --new-address, then devmate restart. For sign-in use a tunnel whose address stays: an OpenAI tunnel, or a Cloudflare tunnel on a domain of yours.');
  // A relay forwards one path and no sign-in pages. It is kept private by the key and by the addresses it answers.
  else if (url && new URL(url).pathname !== '/mcp') check('security', 'warn', 'The relay has no sign-in and cannot have one: it forwards only the path its address ends in. That path ends in a key, and unless the relay was set up with --any-address it answers only the addresses ChatGPT and Claude connect from and this computer. Whoever has the whole address and comes from such an address can read and change your projects and run commands.',
    'Give the address (devmate mcp-url) only to your own client, and do not paste it anywhere else.');
  else if (url && service.config.auth.mode === 'none') check('security', 'warn', 'The public URL has no sign-in: anyone who learns it can read and change your projects and run commands.',
    'Require sign-in (auth mode oauth, issuer ' + new URL(url).origin + '): add --auth oauth to devmate connect, or use "Configure Connection" in the editor. Each client then signs in once with a code from devmate login-code.');
  else check('security', 'ok', service.config.auth.mode === 'oauth' && (url || !tunnelled) ? 'OAuth sign-in is required on the public route.' : 'No public URL is exposed.');
  // Said on its own, so that "sign-in is required" is not read as holding for the tunnel's way too.
  if (tunnelled) check('security.tunnel', 'info', 'What comes through OpenAI\'s tunnel ' + tunnelled.tunnelId + ' is taken as yours without sign-in' + (url && service.config.auth.mode === 'oauth' ? ': the sign-in is asked at the address only' : '') +
    '. Who may use the tunnel is decided in the OpenAI account it belongs to, not here: whoever uses that account, or was given the tunnel there, works on this computer as you.',
  'Keep the account and the tunnel (' + TUNNEL_HELP.settings + ') to people you would let work on this computer.');
  // Whether a client got through at all, and as what: the answer to "ChatGPT is connected but the tools look wrong".
  const client = service.lastClient;
  // (What it calls itself is its own to choose: given as a name, in quotes it cannot close, and cut short.)
  if (client) check('client', 'info', 'The last MCP client called itself ' + (client.name ? named(client.name) : 'nothing') + (client.userAgent ? ' (sender line ' + named(client.userAgent, 120) + ')' : '') + ' and was shown the tool names of ' +
    { gpt: 'ChatGPT and Codex', claude: 'Claude', generic: 'DevMate itself', agent: 'a coding agent on this computer (what DevMate adds to its own tools)' }[client.surface] + ', ' +
    { address: 'as the address it used says (?tools=' + client.surface + ')', name: 'going by that name', tunnel: 'because it came through OpenAI\'s tunnel', default: 'because nothing about it was recognised' }[client.by] + ', at ' + client.at + '.',
  // The address is the owner's to add to; a tunnel id has no place for it.
  client.by === 'address' || client.tunnel ? null : 'To give a client other tool names, add ?tools=gpt, ?tools=claude, ?tools=agent or ?tools=generic to the MCP address it uses. Every tool can be called under any of the names, whichever were shown.');
  // The owner's browser: connected, registered and waiting for a browser to be opened, or not set up. A quick look:
  // the system is asked about the registration only where this instance has written one.
  const browser = service.browser.status();
  const registration = browser.connected ? null : await (service.browserHost || createChromeRegistration({ instanceRoot: service.instanceRoot, cli: fileURLToPath(new URL('../cli.mjs', import.meta.url)) })).status({ ask: false }).catch(() => null);
  // Several browsers: one is used, and which one is the owner's to say in the panel of the browser they mean. A
  // browser's name is what its extension said of itself, so it stands here as a name (in quotes, cut short).
  const others = (browser.connections || []).slice(1).map(one => named(one.browser || 'a browser', 40) + (one.paused ? ' (paused)' : '')).join(', ');
  if (browser.connected) check('chrome', browser.paused ? 'warn' : 'ok', 'The DevMate extension' + (browser.extension ? ' ' + browser.extension : '') + ' in ' + (browser.browser || 'the browser') + ' is connected' +
    (browser.paused ? ', and paused there: every request is refused until you let DevMate use that browser again in the extension\'s panel.' : ': its bookmarks, tabs, history, downloads and the page in front are available to your client (capability_list {engine:"chrome"}).') +
    (others ? ' ' + browser.connections.length + ' browsers are connected and this is the one that is used; also connected: ' + others + '. To use another, open the DevMate panel in it and choose "Use this browser".' : ''));
  else if (registration?.stale) check('chrome', 'warn', 'The browser was registered with a Node or a copy of DevMate that is no longer there, so the DevMate extension cannot reach this runtime.', 'Register it again: devmate chrome install');
  else if (registration?.registered) check('chrome', 'info', 'DevMate is registered with ' + registration.browsers.join(', ') + '; no browser with the DevMate extension is connected right now.', 'Open the browser. If the extension is not in it yet, devmate chrome says where to load it from.');
  else if (registration?.supported) check('chrome', 'info', 'The browser is not connected to DevMate: its bookmarks, tabs, history and downloads are not available to your client.', 'Connect it: devmate chrome install');
  // The clients on this computer DevMate was added to (devmate client add): said where there is one, and where one
  // was written for a Node that is gone or another instance.
  try {
    const { clients } = createClientRegistration({ instanceRoot: service.instanceRoot, cli: fileURLToPath(new URL('../cli.mjs', import.meta.url)) }).status();
    const added = clients.filter(item => item.registered), stale = added.filter(item => item.stale), list = items => items.map(item => item.client).join(', ');
    if (stale.length) check('clients', 'warn', 'DevMate was added to ' + list(stale) + ', but what starts it there is gone (the Node it was added with, or DevMate\'s bridge in the instance directory): it cannot start DevMate.','Add it again: ' + stale.map(item => 'devmate client add ' + item.client).join('; '));
    else if (added.length) check('clients', 'ok', 'DevMate is one of the MCP servers of ' + list(added) + ' on this computer.');
  } catch { /* a settings file that cannot be read is said by devmate client */ }
  // Full access is a choice, not a fault. Without sign-in on a public route it is everyone's who learns the address.
  if (service.fullAccess()) check('access', url && service.config.auth.mode === 'none' ? 'warn' : 'info',
    'Full access: a client connected as the owner can share folders, read credential files and answer agents' +
      (service.desktop.reading() ? ', and read the windows on this screen (switched off alone with: ' + SWITCH_OFF + ')' : '') + ', and agent permission requests are granted automatically.' +
      (url && service.config.auth.mode === 'none' ? ' The public URL has no sign-in, so that is anyone who learns it.' : ''),
    'Back to the default with: devmate access guarded (or "Change Permission Profile" in the editor).');
  else check('access', 'ok', 'Guarded: sharing folders, credential files and agent approvals stay with you at this computer.');
  // What a coding agent does for a connected client is spent on the owner's account with its provider.
  if (service.delegation === 'allow') check('delegation', 'info', 'A connected client hands tasks to the coding agents here without asking you; each runs on your account with the provider.', 'To be asked for each task first: devmate delegation ask');
  else check('delegation', 'ok', service.delegation === 'off' ? 'A connected client cannot hand tasks to the coding agents here.'
    : 'A task that a connected client hands to a coding agent waits until you allow it at this computer, in either access profile.' + (service.fullAccess() ? ' Full access does not answer it for you.' : ''));
  const database = service.store.metrics();
  check('storage', database.databaseBytes > 1024 ** 3 ? 'warn' : 'ok', Math.round(database.databaseBytes / 1048576) + ' MiB state, ' + database.events + ' journal events, ' + service.config.retentionDays + '-day retention',
    database.databaseBytes > 1024 ** 3 ? 'Lower retentionDays in the settings.' : null);
  const worst = ['fail', 'warn'].find(level => checks.some(item => item.status === level)) || 'ok';
  return { status: worst, version: VERSION, instance: service.identity, checks };
}
