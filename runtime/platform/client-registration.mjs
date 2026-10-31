import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { instanceDirectory } from '../client.mjs';
import { DomainError } from '../store.mjs';
import { INHERITED, PROVIDER_ENV } from '../agents/common.mjs';

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
  // (Claude Code keeps it in CLAUDE_CONFIG_DIR where that is set.)
  if (client === 'claude-code') return path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json');
  if (client === 'codex') return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
  if (client === 'claude-desktop') {
    if (platform !== 'win32') return platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json');
    // Claude Desktop installed as an app package reads the copy of its folder that Windows keeps for the package, not
    // the one in the owner's AppData: that is where it is written.
    const packages = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Packages');
    let packaged = null;
    try { packaged = fs.readdirSync(packages).find(name => /^Claude_[a-z0-9]+$/i.test(name)) || null; } catch { /* no packages */ }
    return packaged ? path.join(packages, packaged, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json')
      : path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  }
  throw fault('invalid_input', 'Choose one of: ' + CLIENTS.join(', '));
}

// Written so that a reader never sees half a file: beside it, then renamed over it (and nothing left beside it where
// that fails). A settings file that is a link (into a folder of dotfiles, say) stays a link: the file it points to is
// the one written. A link to nothing is not made a file of its own.
function writeWhole(file, text, mode = 0o600) {
  let real = file;
  try { real = fs.realpathSync(file); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('invalid_settings', file + ' is a link to ' + fs.readlinkSync(file) + ', which is not there. It was left as it is: correct the link, then run the command again.');
  }
  fs.mkdirSync(path.dirname(real), { recursive: true });
  const temporary = real + '.devmate-' + process.pid;
  try { fs.writeFileSync(temporary, text, { mode }); fs.renameSync(temporary, real); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
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

// config.toml is edited without a TOML library, and so only where that is safe. The file is read one statement at a
// time (a table's header, or a key and its value, which a list can carry over several lines), as far as it takes to
// know where each starts and ends and which key it defines, whether it is written bare, quoted or dotted. DevMate's
// own table, [mcp_servers.devmate], is replaced or taken out whole; every other line of the file stays as it is (its
// comments, its line endings, a comment that belongs to the next table). A file that defines devmate another way,
// gives mcp_servers a value of its own (where no table can be added to it), holds a multi-line string, or is not
// TOML this reading understands, is left as it is, and said so.
const BARE = /[A-Za-z0-9_-]+/y, BASIC = /"(?:[^"\\\r\n]|\\[^\r\n])*"/y, LITERAL = /'[^'\r\n]*'/y;
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
const unescape = body => body.replace(/\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|(.))/g, (whole, short, long, one) => {
  const code = parseInt(short || long, 16);
  return one !== undefined ? ESCAPES[one] ?? whole : code <= 0x10ffff ? String.fromCodePoint(code) : whole;
});
function tomlStatements(text, unreadable, multiLine) {
  const statements = [];
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0, line = 0;
  const take = pattern => { pattern.lastIndex = at; const found = pattern.exec(text); if (!found) return null; at = pattern.lastIndex; return found[0]; };
  const blank = () => { while (text[at] === ' ' || text[at] === '\t') at++; };
  // The end of a line, after its comment: false where the line goes on with something else.
  const lineEnd = () => {
    if (text[at] === '#') while (at < text.length && text[at] !== '\n') at++;
    if (at >= text.length) return true;
    if (text[at] === '\r' && text[at + 1] === '\n') at++;
    if (text[at] !== '\n') return false;
    at++; line++; return true;
  };
  const key = () => {
    const path = [];
    do {
      blank();
      const part = take(BARE) ?? take(BASIC) ?? take(LITERAL);
      if (part === null) throw unreadable(line + 1);
      path.push(part[0] === '"' ? unescape(part.slice(1, -1)) : part[0] === '\'' ? part.slice(1, -1) : part);
      blank();
    } while (text[at] === '.' && ++at);
    return path;
  };
  // A value as it is written: a string, a list or an inline table to its closing bracket (over several lines where it
  // is a list), or anything else to the end of its line.
  const value = () => {
    const begin = at;
    let depth = 0;
    for (;;) {
      const one = text[at];
      if (one === undefined) { if (depth) throw unreadable(line + 1); break; }
      if (text.startsWith('"""', at) || text.startsWith('\'\'\'', at)) throw multiLine();
      if (one === '"' || one === '\'') { if (take(one === '"' ? BASIC : LITERAL) === null) throw unreadable(line + 1); continue; }
      if (one === '#' || one === '\n' || one === '\r') { if (!depth) break; if (!lineEnd()) throw unreadable(line + 1); continue; }
      if (one === '[' || one === '{') depth++;
      else if (one === ']' || one === '}') { if (!depth) throw unreadable(line + 1); depth--; }
      at++;
    }
    if (!text.slice(begin, at).trim()) throw unreadable(line + 1);
    return text.slice(begin, at).trim();
  };
  while (at < text.length) {
    blank();
    if (lineEnd()) continue;
    const first = line;
    if (text[at] === '[') {
      const array = text[at + 1] === '[';
      at += array ? 2 : 1;
      const path = key();
      if (text[at] !== ']' || (array && text[at + 1] !== ']')) throw unreadable(line + 1);
      at += array ? 2 : 1; blank();
      if (!lineEnd()) throw unreadable(line + 1);
      statements.push({ first, last: first, header: path, array });
    } else {
      const path = key();
      if (text[at] !== '=') throw unreadable(line + 1);
      at++; blank();
      const written = value(), last = line;
      if (!lineEnd()) throw unreadable(line + 1);
      statements.push({ first, last, key: path, value: written });
    }
  }
  return statements;
}
// A string or a list of strings, as a value in DevMate's table is written; anything else is not read (undefined).
function tomlValue(written) {
  const one = text => text[0] === '"' ? unescape(text.slice(1, -1)) : text.slice(1, -1);
  if (/^(?:"(?:[^"\\]|\\.)*"|'[^']*')$/.test(written)) return one(written);
  if (/^\[\s*\]$/.test(written)) return [];
  const item = /\s*("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')\s*(?:,?\s*\]$|(,)\s*(?=\S))/y, items = [];
  item.lastIndex = written[0] === '[' ? 1 : written.length;
  for (let found; (found = item.exec(written));) { items.push(one(found[1])); if (!found[2]) return items; }
  return undefined;
}
function codexTable(text, file) {
  const lines = text.split(/\r?\n/), refuse = why => fault('invalid_settings', file + ' ' + why + '. It was left as it is: change devmate there by hand, or take that out and run the command again.');
  const statements = tomlStatements(text, at => refuse('is not TOML DevMate can read (line ' + at + ')'), () => refuse('holds a multi-line string, which DevMate does not edit'));
  const under = (path, ...keys) => keys.every((key, index) => path[index] === key);
  let table = [], own = false, start = -1, end = -1;
  const values = new Map();
  for (const statement of statements) {
    if (statement.header) {
      table = statement.header; own = false;
      if (table.length === 2 && under(table, 'mcp_servers', 'devmate') && !statement.array) {
        if (start >= 0) throw refuse('defines [mcp_servers.devmate] twice');
        own = true; start = statement.first; end = start + 1;
      } else if (under(table, 'mcp_servers', 'devmate')) throw refuse('defines devmate in a form DevMate does not write ([mcp_servers.devmate.…] or [[mcp_servers.devmate]])');
      else if (table.length === 1 && under(table, 'mcp_servers') && statement.array) throw refuse('defines mcp_servers as a list of tables ([[mcp_servers]])');
      continue;
    }
    // (A comment and blank lines right above the next table are that table's.)
    if (own) { end = statement.last + 1; if (statement.key.length === 1) values.set(statement.key[0], statement.value); continue; }
    const full = [...table, ...statement.key];
    if (under(full, 'mcp_servers', 'devmate')) throw refuse('defines devmate in a form DevMate does not write (a dotted key or an inline table, at line ' + (statement.first + 1) + ')');
    if (full.length === 1 && full[0] === 'mcp_servers') throw refuse('gives mcp_servers a value of its own (an inline table, at line ' + (statement.first + 1) + '), beside which DevMate cannot add its table');
  }
  return { lines, start, end, values };
}
const tomlString = value => JSON.stringify(String(value));
// What the owner's own environment has that Codex does not hand an MCP server by itself, and that a runtime the bridge
// starts keeps for its whole life and serves every client with: what the commands and agents it starts in turn are
// given (../agents/common.mjs), the account variables of an agent that is to use them, and the credential of a
// connection that is named by a variable.
const CODEX_PASSED = [...new Set([...INHERITED, 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'PSModulePath', 'ProgramData', 'ProgramFiles', 'ComSpec',
  ...Object.values(PROVIDER_ENV).flatMap(vendor => [...vendor.home, ...vendor.keys]), 'CLOUDFLARE_TUNNEL_TOKEN', 'CONTROL_PLANE_API_KEY'])];

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
    if (readText(launcher) !== LAUNCHER) writeWhole(launcher, LAUNCHER, 0o644);
    const launch = JSON.stringify({ cli, instance }, null, 2) + '\n';
    if (readText(target) !== launch) writeWhole(target, launch);
  }
  // What each client has written for DevMate now: the command and its arguments, or null.
  function registered(client) {
    const file = fileOf(client);
    if (client === 'codex') {
      const { start, values } = codexTable(readText(file), file);
      if (start < 0) return null;
      const value = key => values.has(key) ? tomlValue(values.get(key)) : undefined;
      return { command: value('command'), args: value('args') };
    }
    const settings = readJson(file), server = settings.mcpServers?.[NAME];
    return server && typeof server === 'object' ? { command: server.command, args: server.args } : null;
  }
  // This instance's bridge: what DevMate wrote for this instance. Another instance's, or one the owner wrote by hand
  // (an http one), is not DevMate's to take out. (Windows names a file in any case.)
  const same = (one, other) => { const [a, b] = [one, other].map(file => path.resolve(String(file))); return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; };
  const ours = found => !!found && Array.isArray(found.args) && found.args.length === 1 && typeof found.args[0] === 'string' && same(found.args[0], launcher);
  function status() {
    const clients = CLIENTS.map(client => {
      let found = null, problem = null;
      try { found = registered(client); } catch (error) { problem = error.message; }
      // stale: it cannot start DevMate as it is (its Node is gone, or the bridge in the instance directory is: the next
      // start of the runtime writes that again). elsewhere: the name devmate stands for something else there.
      const broken = ours(found) && !(typeof found.command === 'string' && fs.existsSync(found.command) && fs.existsSync(launcher) && fs.existsSync(target));
      return { client, file: fileOf(client), registered: ours(found), ...(broken ? { stale: true } : {}), ...(found && !ours(found) ? { elsewhere: true } : {}), ...(problem ? { problem } : {}) };
    });
    return { clients, launcher, node };
  }
  function add(client) {
    if (!CLIENTS.includes(client)) throw fault('invalid_input', 'Choose one of: ' + CLIENTS.join(', '));
    const file = fileOf(client), before = registered(client);
    writeLauncher();
    if (client === 'codex') {
      const text = readText(file), { lines, start, end } = codexTable(text, file), eol = /\r\n/.test(text) ? '\r\n' : '\n';
      // A runtime that is not running is started by the bridge first: the client is given time for that, and for the
      // longest call DevMate itself bounds (DevMate's own tools answer within 50 seconds and say how to ask again; steps
      // in the browser, chrome.page.run, take up to 5 minutes). Codex hands an MCP server only a few variables of its
      // own; the owner's that a runtime needs are named to it.
      const table = ['[mcp_servers.devmate]', 'command = ' + tomlString(node), 'args = [' + tomlString(launcher) + ']', 'startup_timeout_sec = 60', 'tool_timeout_sec = 330',
        'env_vars = [' + CODEX_PASSED.map(tomlString).join(', ') + ']'];
      const kept = start < 0 ? lines : [...lines.slice(0, start), ...table, ...lines.slice(end)];
      if (start < 0) { while (kept.length && kept.at(-1) === '') kept.pop(); if (kept.length) kept.push(''); kept.push(...table, ''); }
      writeWhole(file, kept.join(eol));
    } else {
      const settings = readJson(file);
      settings.mcpServers = { ...(settings.mcpServers && typeof settings.mcpServers === 'object' ? settings.mcpServers : {}),
        [NAME]: client === 'claude-code' ? { type: 'stdio', ...entry(), env: {} } : entry() };
      writeWhole(file, JSON.stringify(settings, null, 2) + '\n');
    }
    // (An entry named devmate that was something else is replaced: the owner asked for this one. Said so.)
    return { client, file, added: true, ...(before && !ours(before) ? { replaced: 'an entry named devmate that was not this DevMate' } : {}) };
  }
  function remove(client) {
    if (!CLIENTS.includes(client)) throw fault('invalid_input', 'Choose one of: ' + CLIENTS.join(', '));
    const file = fileOf(client), found = registered(client);
    if (!ours(found)) return { client, file, removed: false, ...(found ? { elsewhere: true } : {}) };
    if (client === 'codex') {
      const text = readText(file), { lines, start, end } = codexTable(text, file), eol = /\r\n/.test(text) ? '\r\n' : '\n';
      const kept = [...lines.slice(0, start), ...lines.slice(end)];
      // (The blank line that stood between it and what came before goes with it.)
      if (start > 0 && kept[start - 1] === '' && (kept[start] === '' || kept[start] === undefined)) kept.splice(start - 1, 1);
      writeWhole(file, kept.join(eol));
    } else {
      const settings = readJson(file);
      delete settings.mcpServers[NAME];
      writeWhole(file, JSON.stringify(settings, null, 2) + '\n');
    }
    return { client, file, removed: true };
  }
  /**
   * At a start of the runtime: the bridge the clients start runs this copy of DevMate. Only where a client was added:
   * the bridge is there, or a client's settings name it (the instance directory's clients folder was taken away).
   */
  function refresh() {
    if (!fs.existsSync(cli)) return { refreshed: false };
    // (A quick look for the launcher's path in the file first: a settings file of Claude Code can be large.)
    const named = text => { const needle = JSON.stringify(launcher).slice(1, -1); return platform === 'win32' ? text.toLowerCase().includes(needle.toLowerCase()) : text.includes(needle); };
    if (!fs.existsSync(target) && !CLIENTS.some(client => { try { return named(readText(fileOf(client))) && ours(registered(client)); } catch { return false; } })) return { refreshed: false };
    writeLauncher();
    return { refreshed: true };
  }
  return { add, remove, status, refresh, launcher };
}
