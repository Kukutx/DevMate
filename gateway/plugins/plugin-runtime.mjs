import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  assertCanMutate, audit, getWritableWorkspace, normalizeSlash, permissionProfile, readConfig,
  resolveWorkspaceCwd, syncTrustedRootsIntoConfig, toolText, writeConfig
} from '../local-shared.mjs';
import {
  listPersistentProcesses, readPersistentOutput, startPersistentProcess, stopPersistentProcess
} from '../persistent-processes.mjs';

const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_MAX_OUTPUT_CHARS = 120000;

function clamp(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveWorkspacePath(workspace, subpath = '.', { mustExist = false, directory = false } = {}) {
  const root = fs.realpathSync.native(workspace.root);
  const candidate = path.resolve(root, subpath || '.');
  if (!isInside(root, candidate)) throw new Error(`Path escapes workspace root: ${subpath}`);
  let existing = candidate;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
  const existingReal = fs.realpathSync.native(existing);
  const resolved = path.resolve(existingReal, path.relative(existing, candidate));
  if (!isInside(root, resolved)) throw new Error(`Path escapes workspace root through symlink/reparse point: ${subpath}`);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (mustExist && !stat) throw new Error(`Path does not exist: ${normalizeSlash(path.relative(root, resolved))}`);
  if (directory && stat && !stat.isDirectory()) throw new Error(`Path is not a directory: ${normalizeSlash(path.relative(root, resolved))}`);
  return resolved;
}

function truncate(value, maxChars) {
  const text = String(value ?? '');
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars, length: text.length };
}

export function runExecutable(executable, args = [], options = {}) {
  const timeoutMs = clamp(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 1800000);
  const maxOutputChars = clamp(options.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, 1000, 500000);
  const cwd = options.cwd || process.cwd();
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(executable, args.map(value => String(value)), {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...(options.environment || {}) }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      const out = truncate(stdout, maxOutputChars);
      const err = truncate(stderr, maxOutputChars);
      resolve({ executable, args, cwd, exitCode: null, timedOut: true, stdout: out.text, stderr: err.text, stdoutTruncated: out.truncated, stderrTruncated: err.truncated });
    }, timeoutMs);
    child.stdout?.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.length > maxOutputChars * 2) stdout = stdout.slice(-maxOutputChars * 2);
    });
    child.stderr?.on('data', chunk => {
      stderr += String(chunk);
      if (stderr.length > maxOutputChars * 2) stderr = stderr.slice(-maxOutputChars * 2);
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = truncate(stdout, maxOutputChars);
      const err = truncate(stderr, maxOutputChars);
      resolve({ executable, args, cwd, exitCode: null, timedOut: false, error: error.message, stdout: out.text, stderr: err.text, stdoutTruncated: out.truncated, stderrTruncated: err.truncated });
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = truncate(stdout, maxOutputChars);
      const err = truncate(stderr, maxOutputChars);
      resolve({ executable, args, cwd, exitCode: code, timedOut: false, stdout: out.text, stderr: err.text, stdoutTruncated: out.truncated, stderrTruncated: err.truncated });
    });
  });
}

function quoteShellArg(value) {
  const text = String(value);
  if (process.platform === 'win32') return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function executableAllowed(manifest, executable) {
  const base = path.basename(String(executable || ''));
  const patterns = manifest.permissions?.executablePatterns || [];
  return patterns.length === 0 || patterns.some(pattern => new RegExp(pattern, 'i').test(base));
}

export function findExecutable(candidates = []) {
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const raw of candidates.map(item => String(item || '').trim()).filter(Boolean)) {
    if (path.isAbsolute(raw)) {
      const stat = fs.statSync(raw, { throwIfNoEntry: false });
      if (stat?.isFile()) return fs.realpathSync.native(raw);
      continue;
    }
    const names = path.extname(raw) || process.platform !== 'win32' ? [raw] : extensions.map(ext => `${raw}${ext}`);
    for (const directory of pathEntries) {
      for (const name of names) {
        const candidate = path.join(directory, name);
        const stat = fs.statSync(candidate, { throwIfNoEntry: false });
        if (stat?.isFile()) return fs.realpathSync.native(candidate);
      }
    }
  }
  return null;
}

export function createPluginRuntime(plugin, server) {
  const manifest = plugin.manifest;
  const readPluginSettings = () => {
    const config = readConfig();
    const merged = { ...plugin.defaultSettings, ...(config.plugins?.settings?.[manifest.id] || {}) };
    return plugin.settingsSchema ? plugin.settingsSchema.parse(merged) : merged;
  };
  const getWorkspace = (workspaceId, { writable = false } = {}) => {
    const config = syncTrustedRootsIntoConfig();
    if (writable) return getWritableWorkspace(config, workspaceId);
    const workspace = workspaceId
      ? config.workspaces?.find(item => item.id === workspaceId || item.name === workspaceId)
      : config.workspaces?.find(item => item.id === config.activeWorkspaceId) || config.workspaces?.find(item => !item.reference) || config.workspaces?.[0];
    if (!workspace) throw new Error('No workspace configured');
    return workspace;
  };
  return {
    plugin: manifest,
    server,
    get settings() { return readPluginSettings(); },
    readConfig,
    writeConfig,
    permissionProfile: () => permissionProfile(readConfig()),
    assertCanMutate: action => assertCanMutate(readConfig(), action),
    toolText,
    audit: (action, payload = {}) => audit(`${manifest.id}:${action}`, payload),
    workspace: {
      get: getWorkspace,
      resolve: resolveWorkspacePath,
      resolveCwd: resolveWorkspaceCwd,
      async ensureDirectory(workspace, subpath) {
        const full = resolveWorkspacePath(workspace, subpath);
        await fsp.mkdir(full, { recursive: true });
        return full;
      }
    },
    executables: {
      find: findExecutable,
      assertAllowed(executable) {
        if (!executableAllowed(manifest, executable)) throw new Error(`Executable is not allowed for ${manifest.id}: ${path.basename(String(executable || ''))}`);
        return executable;
      },
      async run(executable, args, options = {}) {
        assertCanMutate(readConfig(), `${manifest.name} command execution`);
        if (!executableAllowed(manifest, executable)) throw new Error(`Executable is not allowed for ${manifest.id}: ${path.basename(String(executable || ''))}`);
        const result = await runExecutable(executable, args, options);
        await audit(`${manifest.id}:exec`, { executable, args, cwd: options.cwd, exitCode: result.exitCode, timedOut: result.timedOut });
        return result;
      },
      async start(executable, args, { workspaceId, cwd = '.', label = '', environment = {}, autoStopAfterMs } = {}) {
        assertCanMutate(readConfig(), `${manifest.name} persistent process execution`);
        if (!executableAllowed(manifest, executable)) throw new Error(`Executable is not allowed for ${manifest.id}: ${path.basename(String(executable || ''))}`);
        const command = [quoteShellArg(executable), ...args.map(quoteShellArg)].join(' ');
        return startPersistentProcess({ workspaceId, command, cwd, label, environment, autoStopAfterMs });
      }
    },
    processes: {
      list: listPersistentProcesses,
      read: readPersistentOutput,
      stop: stopPersistentProcess
    }
  };
}

export const __test = { executableAllowed, isInside, quoteShellArg, truncate };
