import fs from 'node:fs';
import path from 'node:path';
import { isSensitiveWorkspacePath, sensitiveWorkspacePathReason } from '../platform/sensitive-path-policy.mjs';
const normalizeSlash = value => String(value).replace(/\\/g, '/');

// Everything an engine child process may inherit from the runtime's environment:
// what a program needs to start and find its own toolchain, and nothing that
// carries the owner's credentials. Every engine child uses this one list.
const ENGINE_ENVIRONMENT = new Set([
  // Locating programs, the user profile and scratch space.
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USER', 'LOGNAME', 'SHELL', 'TERM',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LANGUAGE', 'TZ',
  'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP',
  // A window on the owner's desktop: Godot, movie capture and headed browsers.
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
  // Toolchains that Godot exports and reverse-engineering backends start.
  'JAVA_HOME', 'JDK_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_NDK_ROOT', 'ANDROID_NDK_HOME',
  'DOTNET_ROOT', 'DOTNET_ROOT(X86)', 'DOTNET_CLI_HOME', 'GHIDRA_INSTALL_DIR', 'VULKAN_SDK'
]);
const ENGINE_ENVIRONMENT_PREFIXES = ['GODOT_', 'LC_'];

export function engineEnvironmentAllows(name) {
  const upper = String(name).toUpperCase();
  return ENGINE_ENVIRONMENT.has(upper) || ENGINE_ENVIRONMENT_PREFIXES.some(prefix => upper.startsWith(prefix));
}

/** The environment of an engine child: the allow-listed variables of `source` plus what the engine sets itself. */
export function engineEnvironment(extra = {}, source = process.env) {
  return { ...Object.fromEntries(Object.entries(source).filter(([name, value]) => typeof value === 'string' && engineEnvironmentAllows(name))), ...extra };
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function assertWorkspacePathSafe(root, candidate, { allowProtectedPaths = false } = {}) {
  const rel = normalizeSlash(path.relative(root, candidate));
  if (!rel || rel === '.') return rel;
  if (!allowProtectedPaths && isSensitiveWorkspacePath(rel)) {
    const error = new Error(`Project path is protected by DevMate credential policy: ${rel}`);
    error.code = 'sensitive_workspace_path';
    error.reason = sensitiveWorkspacePathReason(rel);
    throw error;
  }
  return rel;
}

export function resolveWorkspacePath(workspace, subpath = '.', { mustExist = false, directory = false, allowProtectedPaths = false } = {}) {
  const root = fs.realpathSync.native(workspace.root);
  const candidate = path.resolve(root, subpath || '.');
  if (!isInside(root, candidate)) throw new Error(`Path escapes workspace root: ${subpath}`);
  assertWorkspacePathSafe(root, candidate, { allowProtectedPaths });
  let existing = candidate;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
  const existingReal = fs.realpathSync.native(existing);
  const resolved = path.resolve(existingReal, path.relative(existing, candidate));
  if (!isInside(root, resolved)) throw new Error(`Path escapes workspace root through symlink/reparse point: ${subpath}`);
  assertWorkspacePathSafe(root, resolved, { allowProtectedPaths });
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (mustExist && !stat) throw new Error(`Path does not exist: ${normalizeSlash(path.relative(root, resolved))}`);
  if (directory && stat && !stat.isDirectory()) throw new Error(`Path is not a directory: ${normalizeSlash(path.relative(root, resolved))}`);
  return resolved;
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
    const names = (path.extname(raw) || process.platform !== 'win32') ? [raw] : extensions.map(ext => `${raw}${ext}`);
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
