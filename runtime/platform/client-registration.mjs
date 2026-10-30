import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { instanceDirectory } from '../client.mjs';
import { DomainError } from '../store.mjs';

// DevMate as an MCP server of the coding agents and chat apps on this computer, in one command each:
// devmate client add claude-code | codex | claude-desktop (and remove). What they are given to start is the same for
// all: the Node that runs DevMate, and a small program in the instance directory that starts DevMate's own stdio
// bridge (devmate mcp, which starts the runtime where it does not run). That program reads which copy of DevMate to
// run from a file beside it, which every start of the runtime keeps current: an update, an editor's extension in a
// folder of its own for every version, nothing on PATH, and the clients' settings stay as they were written.
// It is written in each client's own settings file, at the place its documentation names, and only there:
//   Claude Code: the user's servers in ~/.claude.json (as "claude mcp add --scope user" writes them);
//   Codex: [mcp_servers.devmate] in config.toml of CODEX_HOME (~/.codex), with time for a runtime to start;
//   Claude Desktop: mcpServers in claude_desktop_config.json of the app's folder.

export const CLIENTS = Object.freeze(['claude-code', 'codex', 'claude-desktop']);
const NAME = 'devmate';
const fault = (code, message) => new DomainError(code, message);
// The program each client starts: DevMate's stdio bridge, for the instance written beside it.
const LAUNCHER = [
  '// Written by DevMate (devmate client add). It starts DevMate\'s stdio bridge with the copy of DevMate that ran last,',
  '// as launch.json beside it says; every start of the runtime keeps that file current.',
  'import fs from \'node:fs\';',
  'import path from \'node:path\';',
  'import { fileURLToPath, pathToFileURL } from \'node:url\';',
  'const here = path.dirname(fileURLToPath(import.meta.url));',
  'const { cli, instance } = JSON.parse(fs.readFileSync(path.join(here, \'launch.json\'), \'utf8\'));',
  'const { main } = await import(pathToFileURL(cli).href);',
  'process.exitCode = await main([\'mcp\', \'--instance\', instance]);',
  ''].join('\n');

/** The settings file of a client on this computer. */
export function clientFile(client, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (client === 'claude-code') return path.join(home, '.claude.json');
  if (client === 'codex') return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
  if (client === 'claude-desktop') return platform === 'win32' ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json');
  throw fault('invalid_input', 'Choose one of: ' + CLIENTS.join(', '));
}

// Written so that a reader never sees half a file: beside it, then renamed over it.
function writeWhole(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.devmate-' + process.pid;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
// A settings file that is there and cannot be read is not written over: it is the owner's, and may hold much more.
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!text.trim()) return {};
  try { const value = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* said below */ }
  throw fault('invalid_settings', file + ' is not JSON DevMate can read. It was left as it is: correct it, then run the command again.');
}
const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } };

// config.toml: the table [mcp_servers.devmate] and its subtables, found by their headers. Everything else of the file
// stays as it was, comments and order included.
const TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(?:devmate|"devmate")\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/, OWN = /^\s*\[\s*mcp_servers\s*\.\s*(?:devmate|"devmate")\s*\]\s*(?:#.*)?$/;
const HEADER = /^\s*\[/;
function withoutTable(text) {
  const lines = text.split(/\r?\n/), kept = [];
  let inside = false;
  for (const line of lines) {
    if (HEADER.test(line)) inside = TABLE.test(line);
    if (!inside) kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}
const tomlString = value => JSON.stringify(String(value));

/**
 * The registration of DevMate with the clients on this computer, for one instance. cli is the DevMate command line to
 * run, node the program that runs it.
 */
export function createClientRegistration({ instanceRoot, cli, node = process.execPath, platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const instance = instanceDirectory(instanceRoot), directory = path.join(instance, 'clients');
  const launcher = path.join(directory, 'devmate-mcp.mjs'), target = path.join(directory, 'launch.json');
  const entry = () => ({ command: node, args: [launcher] });
  const fileOf = client => clientFile(client, { platform, env, home });
  function writeLauncher() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (readText(launcher) !== LAUNCHER) fs.writeFileSync(launcher, LAUNCHER, { mode: 0o644 });
    const launch = JSON.stringify({ cli, instance }, null, 2) + '\n';
    if (readText(target) !== launch) fs.writeFileSync(target, launch, { mode: 0o600 });
  }
  // What each client has written for DevMate now: the command and its arguments, or null.
  function registered(client) {
    const file = fileOf(client);
    if (client === 'codex') {
      const text = readText(file), lines = text.split(/\r?\n/);
      const start = lines.findIndex(line => OWN.test(line));
      if (start < 0) return null;
      const body = [];
      for (const line of lines.slice(start + 1)) { if (HEADER.test(line)) break; body.push(line); }
      const value = key => { const found = body.map(line => line.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.+?)\\s*(?:#.*)?$'))).find(Boolean); try { return found ? JSON.parse(found[1]) : undefined; } catch { return undefined; } };
      return { command: value('command'), args: value('args') };
    }
    const settings = readJson(file), server = settings.mcpServers?.[NAME];
    return server && typeof server === 'object' ? { command: server.command, args: server.args } : null;
  }
  // This instance's bridge: what DevMate wrote for this instance. Another instance's is that one's business.
  const ours = found => !!found && Array.isArray(found.args) && found.args.length === 1 && found.args[0] === launcher;
  function status() {
    const clients = CLIENTS.map(client => {
      let found = null, problem = null;
      try { found = registered(client); } catch (error) { problem = error.message; }
      // stale: it cannot start any more, its Node is gone. (Which Node it is does not matter otherwise: the runtime may
      // run under another one, an editor's choice.) elsewhere: the name devmate stands for another instance there.
      return { client, file: fileOf(client), registered: ours(found), ...(ours(found) && !(typeof found.command === 'string' && fs.existsSync(found.command)) ? { stale: true } : {}),
        ...(found && !ours(found) ? { elsewhere: true } : {}), ...(problem ? { problem } : {}) };
    });
    return { clients, launcher, node };
  }
  function add(client) {
    if (!CLIENTS.includes(client)) throw fault('invalid_input', 'Choose one of: ' + CLIENTS.join(', '));
    writeLauncher();
    const file = fileOf(client);
    if (client === 'codex') {
      const before = withoutTable(readText(file));
      // A runtime that is not running is started by the bridge first: the client is given time for that, and for a
      // call that waits on a command (DevMate's own tools answer within 50 seconds and say how to ask again).
      const table = ['[mcp_servers.devmate]', 'command = ' + tomlString(node), 'args = [' + tomlString(launcher) + ']', 'startup_timeout_sec = 60', 'tool_timeout_sec = 120'].join('\n');
      writeWhole(file, (before ? before + '\n\n' : '') + table + '\n');
    } else {
      const settings = readJson(file);
      settings.mcpServers = { ...(settings.mcpServers && typeof settings.mcpServers === 'object' ? settings.mcpServers : {}),
        [NAME]: client === 'claude-code' ? { type: 'stdio', ...entry(), env: {} } : entry() };
      writeWhole(file, JSON.stringify(settings, null, 2) + '\n');
    }
    return { client, file, added: true };
  }
  function remove(client) {
    if (!CLIENTS.includes(client)) throw fault('invalid_input', 'Choose one of: ' + CLIENTS.join(', '));
    const file = fileOf(client);
    if (!registered(client)) return { client, file, removed: false };
    if (client === 'codex') writeWhole(file, withoutTable(readText(file)) + '\n');
    else {
      const settings = readJson(file);
      delete settings.mcpServers[NAME];
      writeWhole(file, JSON.stringify(settings, null, 2) + '\n');
    }
    return { client, file, removed: true };
  }
  /** At a start of the runtime: the bridge the clients start runs this copy of DevMate. Only where a client was added. */
  function refresh() {
    if (!fs.existsSync(target) || !fs.existsSync(cli)) return { refreshed: false };
    writeLauncher();
    return { refreshed: true };
  }
  return { add, remove, status, refresh, launcher };
}
