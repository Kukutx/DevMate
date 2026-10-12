import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { instanceFiles } from './client.mjs';
import { MARK as REDACTED, redactSecrets } from './platform/redact.mjs';
import { plainName } from './operations/shared.mjs';
import { MESSAGE_SHOWN } from './usage.mjs';
import { VERSION } from './version.mjs';

// One text a person can paste into a bug report: what the doctor found, how the operations went and what the
// runtime logged last, with what is private taken out. It is a best effort on known shapes, as redaction always is,
// and its first line says so: the person reads it before sharing it.
const literal = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A path as it may be spelled: either separator, a backslash doubled inside JSON, any case on Windows.
const spelled = value => new RegExp(value.split(/[\\/]+/).map(literal).join('(?:\\\\{1,2}|/)'), process.platform === 'win32' ? 'gi' : 'g');
// Everything that is put in for something taken out. What is looked for by a word somebody chose (a host, the name of
// a project) is looked for outside of these only: a project called "redacted" or "email" finds nothing in them.
const PUT_IN = new RegExp('(<assigned>\\.trycloudflare\\.com|<(?:folder-\\d+|user|public-host|assigned|instance|key|email|address)>|' + literal(REDACTED) + ')');
const outside = (text, change) => text.split(PUT_IN).map((part, index) => index % 2 ? part : change(part)).join('');

/**
 * Take out of a text what says who and where: credentials, the home directory and the account name, the shared
 * folders (places: [path, label]) and what they are called (names: [name, label]), the public host names, addresses
 * and the key of a quick tunnel.
 */
export function anonymize(text, { home = os.homedir(), places = [], names = [], hosts = [] } = {}) {
  let result = redactSecrets(String(text ?? ''));
  // The longest first, so that a folder inside the home directory is named as the folder it is.
  for (const [place, label] of [...places, [home, '~']].filter(([place]) => typeof place === 'string' && place.length > 3).sort((a, b) => b[0].length - a[0].length)) {
    result = result.replace(spelled(place), label);
  }
  result = result.replace(/((?:\\{1,2}|\/)(?:Users|home)(?:\\{1,2}|\/))[^\\/\s"'<>:|]+/gi, '$1<user>');
  result = result.replace(/[a-z0-9-]+\.trycloudflare\.com/gi, '<assigned>.trycloudflare.com').replace(/\/mcp\/[A-Za-z0-9_-]{20,}/g, '/mcp/<key>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '<email>')
    .replace(/\b(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/g, '<address>')
    // IPv6, written out or shortened with "::". A time of day has two colons and is not one.
    .replace(/(?<![A-Za-z0-9_:.])(?:(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?)(?![A-Za-z0-9_:])/gi, '<address>');
  // The public hosts after the addresses: taken out before them, the host of deploy@relay.example.com left the
  // account on the owner's own server standing before the @. All in one pass and the longest first, so that none
  // finds anything in what was put in for another.
  const known = [...new Set(hosts.filter(host => typeof host === 'string' && host.length > 3))].sort((a, b) => b.length - a.length);
  if (known.length) result = outside(result, part => part.replace(new RegExp(known.map(literal).join('|'), 'gi'), '<public-host>'));
  // Names last. A project's name is whatever somebody called it (a client may rename one), and taken out first it
  // could keep what the rules above are there to remove: "acme" in bob@acme.com left the part before the @. For the
  // same reason a name never reaches into what was put in above (<email>, <folder-2>, [redacted]).
  // A project's name is often the name of a client or a product. Short names are left: replacing "app" everywhere
  // would say less, not more. The longest first, so that "Acme Shop" is taken out as itself and not as "Acme" with a
  // word left over. (A name of blanks alone is no name to look for.) A name is looked for as a word: "Acme" is not
  // taken out of "AcmeCorp". That holds at an end of the name that is a letter or a digit, and only there: "[beta]"
  // and "/shop" are taken out wherever they stand. All names are looked for in one pass, so that a project called
  // "folder" finds nothing in the <folder-1> that was put in for another.
  const word = /[A-Za-z0-9_]/, labels = new Map();
  for (const [name, label] of names.filter(([name]) => typeof name === 'string' && name.trim().length > 3).sort((a, b) => b[0].length - a[0].length)) if (!labels.has(name)) labels.set(name, label);
  if (!labels.size) return result;
  const wanted = new RegExp([...labels.keys()].map(name => (word.test(name[0]) ? '(?<![A-Za-z0-9_])' : '') + literal(name) + (word.test(name.at(-1)) ? '(?![A-Za-z0-9_])' : '')).join('|'), 'g');
  return outside(result, part => part.replace(wanted, found => labels.get(found)));
}

function logTail(instanceRoot, { bytes = 24000, lines = 60 } = {}) {
  const file = instanceFiles(instanceRoot).log;
  try {
    const size = fs.statSync(file).size, start = Math.max(0, size - bytes), buffer = Buffer.alloc(size - start), fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buffer, 0, buffer.length, start); } finally { fs.closeSync(fd); }
    // (Read from the middle of the file, the first line is the end of one. A path cut in two is not recognised as the
    // path it was and would be left standing: that line is not shown.)
    return buffer.toString('utf8').split(/\r?\n/).slice(start ? 1 : 0).filter(Boolean).slice(-lines);
  } catch { return []; }
}

// The shared folders of an instance whose runtime is not running, read from its state without changing it: their
// names are what a log line is most likely to give away.
export function recordedFolders(instanceRoot) {
  const file = path.join(instanceRoot, 'state.sqlite');
  if (!fs.existsSync(file)) return [];
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return db.prepare("SELECT json_extract(data,'$.root') AS root FROM entities WHERE kind='project'").all().map(row => row.root).filter(root => typeof root === 'string');
  } catch { return []; }
  finally { try { db?.close(); } catch {} }
}
const folderPlaces = roots => roots.map((root, index) => [root, '<folder-' + (index + 1) + '>']);

// A report is put together from pieces of two kinds. Its own words: the heading, the headings of its parts, the mark
// and the id of an entry, the name of an operation. And content: what an entry says, the message of a failure, a line
// of the log. Only content is cleaned, each piece by itself, and the report's own words are put around it afterwards.
// So nothing that is taken out of content can take a mark, an id or a heading with it, whatever a project is called:
// cleaned as one text, a project named "ok ] node" turned the entry "[ ok ] node: ..." into "[ <folder-1>: ...".
const MARK = { ok: '[ ok ]', info: '[info]', warn: '[warn]', fail: '[FAIL]' };
const HEADING = 'DevMate report. Credentials, private paths, account names and addresses were taken out as far as they can be recognised: read it before you share it.';
const SECTIONS = { checks: 'Checks', operations: 'Operations since the start: name, calls (through MCP), failed, ms for half of the calls, for 19 in 20, slowest', failures: 'Recent failures, newest first', log: 'Runtime log, last lines' };
// One entry on one line: a name or a message from elsewhere does not begin a line of its own beside the report's.
const oneLine = text => String(text ?? '').replace(/\s*[\r\n]+\s*/g, ' ');
const checkLines = (checks, clean) => checks.flatMap(item => [MARK[item.status] + ' ' + item.id + ': ' + clean(oneLine(item.detail)), ...(item.fix && item.status !== 'ok' ? ['       -> ' + clean(oneLine(item.fix))] : [])]);
// Cleaned first and cut short afterwards: half a mail address, or the first characters of a key, are not recognised.
const logLines = (instanceRoot, clean) => logTail(instanceRoot).map(line => clean(line).slice(0, 600));

// What can be said without a runtime: what is seen from outside, and what it logged before it stopped.
export function offlineReport(instanceRoot, doctor) {
  const clean = text => anonymize(text, { places: [...folderPlaces(recordedFolders(instanceRoot)), [instanceRoot, '<instance>']] });
  return [HEADING, '', clean('DevMate ' + doctor.version + ' · ' + process.platform + ' ' + process.arch + ' ' + os.release() + ' · Node ' + process.versions.node + ' · the runtime is not running'),
    '', SECTIONS.checks, ...checkLines(doctor.checks, clean), '', SECTIONS.log, ...logLines(instanceRoot, clean)].join('\n');
}

export async function report(service) {
  const doctor = await service.doctor(), usage = service.usage.snapshot({ whole: true }), config = service.config;
  const projects = service.store.list('project', { limit: 10000 });
  // A host as it is written with its port and without: an address that names a port (https://home.example.com:8443)
  // is said without it wherever the name alone is looked up ("getaddrinfo ENOTFOUND home.example.com").
  const hostsOf = value => { try { const url = new URL(value); return [url.host, url.hostname]; } catch { return [value]; } };
  const places = [...folderPlaces(projects.map(project => project.root)), [service.instanceRoot, '<instance>']];
  const hosts = [service.publicUrl(), config.auth?.issuer, config.connection?.host].filter(Boolean).flatMap(hostsOf);
  // A name is taken out as it is written in a line (on one line), and as the doctor says it (without the characters
  // it leaves out, cut short).
  const names = projects.flatMap((project, index) => [...new Set([oneLine(project.name).trim(), plainName(project.name).trim()])].map(name => [name, '<folder-' + (index + 1) + '>']));
  const clean = text => anonymize(text, { places, names, hosts });
  // What the report says of the computer and the settings is its own, and holds no name of a project.
  const own = text => anonymize(text, { places, hosts });
  const access = level => projects.filter(project => project.access === level).length;
  const failures = usage.recentFailures.slice(0, 20);
  return { text: [HEADING, '',
    own('DevMate ' + VERSION + ' · ' + process.platform + ' ' + process.arch + ' ' + os.release() + ' · Node ' + process.versions.node + ' · ' + service.processes.shell.label),
    own('Connection: ' + config.connection.kind + (config.openaiTunnel ? ' with openai-tunnel beside it' : '') + ' · sign-in: ' + config.auth.mode + ' · profile: ' + service.accessProfile + ' · delegation: ' + service.delegation + ' · up ' + Math.round(process.uptime() / 60) + ' min'),
    'Shared folders: ' + projects.length + ' (' + access('write') + ' read and write, ' + access('read') + ' read only) · editor windows: ' + service.windows.list().length,
    '', SECTIONS.checks, ...checkLines(doctor.checks, clean),
    '', SECTIONS.operations,
    // (The name of an operation is one of DevMate's own, or "(unknown)" for whatever else was asked for. The code of
    // an error is whatever was thrown, and so content like its message.)
    ...(usage.operations.length ? usage.operations.map(item => item.name + '  ' + item.calls + ' (' + item.connected + ')  ' + item.failed + '  ' + (item.p50Ms ?? '>50000') + '  ' + (item.p95Ms ?? '>50000') + '  ' + item.maxMs +
      (item.failed ? '  ' + Object.entries(item.errors).map(([code, count]) => clean(oneLine(code)) + '×' + count).join(', ') : '')) : ['(none yet)']),
    '', SECTIONS.failures,
    ...(failures.length ? failures.map(item => '#' + item.request + ' ' + item.at + ' ' + item.operation + ' ' + clean(oneLine(item.code)) + ' (' + item.caller + ', ' + item.ms + ' ms): ' + clean(oneLine(item.message)).slice(0, MESSAGE_SHOWN)) : ['(none)']),
    '', SECTIONS.log, ...logLines(service.instanceRoot, clean)].join('\n') };
}
