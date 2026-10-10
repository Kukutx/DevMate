import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { instanceFiles } from './client.mjs';
import { redactSecrets } from './platform/redact.mjs';
import { VERSION } from './version.mjs';

// One text a person can paste into a bug report: what the doctor found, how the operations went and what the
// runtime logged last, with what is private taken out. It is a best effort on known shapes, as redaction always is,
// and its first line says so: the person reads it before sharing it.
const literal = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A path as it may be spelled: either separator, a backslash doubled inside JSON, any case on Windows.
const spelled = value => new RegExp(value.split(/[\\/]+/).map(literal).join('(?:\\\\{1,2}|/)'), process.platform === 'win32' ? 'gi' : 'g');

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
  for (const host of hosts) if (typeof host === 'string' && host.length > 3) result = result.replace(new RegExp(literal(host), 'gi'), '<public-host>');
  // A project's name is often the name of a client or a product. Short names are left: replacing "app" everywhere would say less, not more.
  for (const [name, label] of names) if (typeof name === 'string' && name.length > 3) result = result.replace(new RegExp('(?<![A-Za-z0-9_])' + literal(name) + '(?![A-Za-z0-9_])', 'g'), label);
  return result.replace(/[a-z0-9-]+\.trycloudflare\.com/gi, '<assigned>.trycloudflare.com').replace(/\/mcp\/[A-Za-z0-9_-]{20,}/g, '/mcp/<key>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '<email>')
    .replace(/\b(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/g, '<address>')
    // IPv6, written out or shortened with "::". A time of day has two colons and is not one.
    .replace(/(?<![A-Za-z0-9_:.])(?:(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?)(?![A-Za-z0-9_:])/gi, '<address>');
}

function logTail(instanceRoot, { bytes = 24000, lines = 60 } = {}) {
  const file = instanceFiles(instanceRoot).log;
  try {
    const size = fs.statSync(file).size, start = Math.max(0, size - bytes), buffer = Buffer.alloc(size - start), fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buffer, 0, buffer.length, start); } finally { fs.closeSync(fd); }
    return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-lines);
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

// What can be said without a runtime: what is seen from outside, and what it logged before it stopped.
export function offlineReport(instanceRoot, doctor) {
  return anonymize([HEADING, '', 'DevMate ' + doctor.version + ' · ' + process.platform + ' ' + process.arch + ' ' + os.release() + ' · Node ' + process.versions.node + ' · the runtime is not running',
    '', 'Checks', ...checkLines(doctor.checks), '', 'Runtime log, last lines', ...logTail(instanceRoot).map(line => line.slice(0, 600))].join('\n'),
  { places: [...folderPlaces(recordedFolders(instanceRoot)), [instanceRoot, '<instance>']] });
}

const MARK = { ok: '[ ok ]', info: '[info]', warn: '[warn]', fail: '[FAIL]' };
const HEADING = 'DevMate report. Credentials, private paths, account names and addresses were taken out as far as they can be recognised: read it before you share it.';
function checkLines(checks) {
  return checks.flatMap(item => [MARK[item.status] + ' ' + item.id + ': ' + item.detail, ...(item.fix && item.status !== 'ok' ? ['       -> ' + item.fix] : [])]);
}

export async function report(service) {
  const doctor = await service.doctor(), usage = service.usage.snapshot(), config = service.config;
  const projects = service.store.list('project', { limit: 10000 });
  const hostOf = value => { try { return new URL(value).host; } catch { return value; } };
  const clean = text => anonymize(text, {
    places: [...folderPlaces(projects.map(project => project.root)), [service.instanceRoot, '<instance>']],
    names: projects.map((project, index) => [project.name, '<folder-' + (index + 1) + '>']),
    hosts: [service.publicUrl(), config.auth?.issuer, config.connection?.host].filter(Boolean).map(hostOf) });
  const access = level => projects.filter(project => project.access === level).length;
  const failures = usage.recentFailures.slice(0, 20);
  const lines = [HEADING, '',
    'DevMate ' + VERSION + ' · ' + process.platform + ' ' + process.arch + ' ' + os.release() + ' · Node ' + process.versions.node + ' · ' + service.processes.shell.label,
    'Connection: ' + config.connection.kind + ' · sign-in: ' + config.auth.mode + ' · profile: ' + service.accessProfile + ' · up ' + Math.round(process.uptime() / 60) + ' min',
    'Shared folders: ' + projects.length + ' (' + access('write') + ' read and write, ' + access('read') + ' read only) · editor windows: ' + service.windows.list().length,
    '', 'Checks', ...checkLines(doctor.checks),
    '', 'Operations since the start: name, calls (through MCP), failed, ms for half of the calls, for 19 in 20, slowest',
    ...(usage.operations.length ? usage.operations.map(item => item.name + '  ' + item.calls + ' (' + item.connected + ')  ' + item.failed + '  ' + (item.p50Ms ?? '>50000') + '  ' + (item.p95Ms ?? '>50000') + '  ' + item.maxMs +
      (item.failed ? '  ' + Object.entries(item.errors).map(([code, count]) => code + '×' + count).join(', ') : '')) : ['(none yet)']),
    '', 'Recent failures, newest first',
    ...(failures.length ? failures.map(item => '#' + item.request + ' ' + item.at + ' ' + item.operation + ' ' + item.code + ' (' + item.caller + ', ' + item.ms + ' ms): ' + item.message) : ['(none)']),
    '', 'Runtime log, last lines', ...(logTail(service.instanceRoot).map(line => line.slice(0, 600)))];
  return { text: clean(lines.join('\n')) };
}
