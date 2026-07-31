import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveGodotExecutable, resolveProject } from './godot-project.mjs';
import { runExecutable } from './plugin-runtime.mjs';

function cleanVersionChannel(value = '') {
  const channel = String(value || '').toLowerCase();
  if (channel.includes('stable')) return 'stable';
  if (channel.includes('rc')) return 'rc';
  if (channel.includes('beta')) return 'beta';
  if (channel.includes('alpha')) return 'alpha';
  if (channel.includes('dev')) return 'dev';
  return 'unknown';
}

export function parseGodotVersion(output = '') {
  const raw = String(output || '').trim().split(/\r?\n/).find(Boolean) || '';
  const match = raw.match(/(?:^|\s|v)(\d+)\.(\d+)(?:\.(\d+))?(?:[.-]([A-Za-z]+)(\d+)?)?/);
  const lower = raw.toLowerCase();
  return {
    raw,
    valid: !!match,
    major: match ? Number(match[1]) : null,
    minor: match ? Number(match[2]) : null,
    patch: match?.[3] ? Number(match[3]) : 0,
    channel: cleanVersionChannel(match?.[4] || raw),
    channelNumber: match?.[5] ? Number(match[5]) : null,
    mono: /(?:^|[._-])mono(?:[._-]|$)/i.test(raw),
    official: lower.includes('official')
  };
}

export function runtimeHostCapabilities(platform = process.platform, arch = process.arch) {
  const capabilities = new Set(['core', 'godot']);
  const archName = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch;
  if (platform === 'win32') capabilities.add(`windows-${archName}`);
  else if (platform === 'darwin') capabilities.add(`macos-${archName}`);
  else if (platform === 'linux') capabilities.add(`linux-${archName}`);
  else capabilities.add(`${platform}-${archName}`);
  return [...capabilities];
}

export function exportTemplateRoots({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const roots = [];
  if (env.GODOT_EXPORT_TEMPLATES_DIR) roots.push(path.resolve(env.GODOT_EXPORT_TEMPLATES_DIR));
  if (platform === 'win32') {
    if (env.APPDATA) roots.push(path.join(env.APPDATA, 'Godot', 'export_templates'));
  } else if (platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Application Support', 'Godot', 'export_templates'));
  } else {
    roots.push(path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'godot', 'export_templates'));
  }
  return [...new Set(roots)];
}

function versionFolderCandidates(version) {
  if (!version?.valid) return [];
  const base = `${version.major}.${version.minor}.${version.patch}`;
  const channel = version.channel === 'unknown' ? 'stable' : version.channel;
  const suffix = version.channelNumber == null ? channel : `${channel}${version.channelNumber}`;
  const candidates = [`${base}.${suffix}`];
  if (version.mono) candidates.unshift(`${base}.${suffix}.mono`);
  return [...new Set(candidates)];
}

async function inspectDirectory(directory) {
  const stat = fs.statSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return { path: directory, exists: false, files: 0, sample: [] };
  const entries = await fsp.readdir(directory).catch(() => []);
  return {
    path: directory,
    exists: true,
    files: entries.length,
    sample: entries.sort().slice(0, 20)
  };
}

async function detectTemplates(version) {
  const roots = exportTemplateRoots();
  const folderCandidates = versionFolderCandidates(version);
  const checked = [];
  for (const root of roots) {
    for (const folder of folderCandidates) checked.push(await inspectDirectory(path.join(root, folder)));
  }
  const installed = checked.find(item => item.exists) || null;
  return {
    available: !!installed,
    installed,
    roots,
    folderCandidates,
    checked
  };
}

async function hasCSharpProject(projectRoot) {
  const entries = await fsp.readdir(projectRoot).catch(() => []);
  return entries.some(name => /\.(?:csproj|sln)$/i.test(name));
}

export async function inspectGodotRuntime(context, { workspaceId, projectSubpath, timeoutMs = 15000 } = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: false });
  const executable = resolveGodotExecutable(context);
  const versionResult = await runExecutable(executable, ['--version'], {
    cwd: project.root,
    timeoutMs: Math.min(60000, Math.max(1000, Number(timeoutMs) || 15000)),
    maxOutputChars: 20000
  });
  const version = parseGodotVersion(versionResult.stdout || versionResult.stderr || '');
  const templates = await detectTemplates(version);
  const csharpProject = await hasCSharpProject(project.root);
  const dotnetExecutable = context.executables.find(['dotnet']);
  const executableName = path.basename(executable);
  const monoBuild = version.mono || /mono/i.test(executableName);
  const hostCapabilities = runtimeHostCapabilities();
  if (dotnetExecutable) hostCapabilities.push('dotnet');
  return {
    ok: versionResult.exitCode === 0 && !versionResult.timedOut && version.valid,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    executable,
    executableName,
    version,
    versionResult,
    host: {
      platform: process.platform,
      arch: process.arch,
      capabilities: [...new Set(hostCapabilities)].sort()
    },
    csharp: {
      project: csharpProject,
      monoBuild,
      dotnetExecutable: dotnetExecutable || null,
      ready: !csharpProject || (monoBuild && !!dotnetExecutable)
    },
    exportTemplates: templates,
    readiness: {
      validate: versionResult.exitCode === 0 && version.valid,
      nativeQa: versionResult.exitCode === 0 && version.valid && (!csharpProject || (monoBuild && !!dotnetExecutable)),
      export: versionResult.exitCode === 0 && version.valid && templates.available
    }
  };
}

export const __test = { cleanVersionChannel, versionFolderCandidates };
