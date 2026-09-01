#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
    const [key, inline] = value.slice(2).split('=', 2);
    options[key] = inline !== undefined ? inline : argv[++index];
    if (options[key] === undefined) throw new Error(`Missing value for --${key}`);
  }
  return options;
}

function targetPlatform(value) {
  const platform = String(value || process.platform).trim().toLowerCase();
  if (!['win32', 'linux'].includes(platform)) throw new Error(`Portable DevMate currently supports win32 and linux; received ${platform}`);
  return platform;
}

function targetArch(value) {
  const arch = String(value || process.arch).trim().toLowerCase();
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Portable DevMate supports x64 and arm64; received ${arch}`);
  return arch;
}

function copy(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Portable source is missing: ${source}`);
  fs.cpSync(source, destination, { recursive: true, force: true, dereference: false });
}

function writeExecutable(file, content) {
  fs.writeFileSync(file, content, 'utf8');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
}

function npmCommand() {
  const cli = String(process.env.npm_execpath || '').trim();
  if (cli && fs.statSync(cli, { throwIfNoEntry: false })?.isFile()) return { command: process.execPath, args: [cli], shell: false };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: process.platform === 'win32' };
}

function installProductionDependencies(appDirectory) {
  const npm = npmCommand();
  const result = spawnSync(npm.command, [...npm.args, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: appDirectory,
    encoding: 'utf8',
    windowsHide: true,
    shell: npm.shell,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`Portable production dependency install failed${detail ? `: ${detail}` : ''}`);
  }
}

function launcherContent(platform, script) {
  if (platform === 'win32') {
    return `@echo off\r\nsetlocal\r\nset "DEVMATE_ROOT=%~dp0"\r\n"%DEVMATE_ROOT%runtime\\node.exe" "%DEVMATE_ROOT%app\\${script.replaceAll('/', '\\')}" %*\r\n`;
  }
  return `#!/bin/sh\nset -eu\nDEVMATE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$DEVMATE_ROOT/runtime/node" "$DEVMATE_ROOT/app/${script}" "$@"\n`;
}

function assertNodeBinary(file, platform) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`Node runtime binary is missing: ${file}`);
  if (platform === 'win32' && path.extname(file).toLowerCase() !== '.exe') {
    throw new Error('Windows portable builds require --node pointing to node.exe');
  }
}

function nodeLicense(nodeBinary) {
  const directory = path.dirname(nodeBinary);
  const candidates = [
    path.join(directory, 'LICENSE'),
    path.join(directory, '..', 'LICENSE'),
    path.join(directory, '..', '..', 'LICENSE')
  ].map(value => path.resolve(value));
  const license = candidates.find(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile());
  if (!license) throw new Error(`Could not locate the bundled Node.js LICENSE near ${nodeBinary}`);
  return license;
}

export function packagePortable(options = {}) {
  const platform = targetPlatform(options.platform);
  const arch = targetArch(options.arch);
  const nodeBinary = path.resolve(String(options.node || process.execPath));
  assertNodeBinary(nodeBinary, platform);
  const destination = path.resolve(String(
    options.out || path.join(root, 'release', `devmate-${packageJson.version}-${platform}-${arch}`)
  ));
  const appDirectory = path.join(destination, 'app');
  const runtimeDirectory = path.join(destination, 'runtime');

  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(appDirectory, { recursive: true });
  fs.mkdirSync(runtimeDirectory, { recursive: true });

  for (const directory of ['gateway', 'host', 'shared', 'scripts']) {
    copy(path.join(root, directory), path.join(appDirectory, directory));
  }
  for (const file of ['config-file-lock.cjs', 'tunnel-provider.js', 'package.json', 'package-lock.json', 'LICENSE']) {
    copy(path.join(root, file), path.join(appDirectory, file));
  }
  fs.mkdirSync(path.join(appDirectory, 'vscode-host'), { recursive: true });
  for (const file of ['shared-tunnel-record-store.js', 'tunnel-settings.js']) {
    copy(path.join(root, 'vscode-host', file), path.join(appDirectory, 'vscode-host', file));
  }

  installProductionDependencies(appDirectory);

  const runtimeName = platform === 'win32' ? 'node.exe' : 'node';
  copy(nodeBinary, path.join(runtimeDirectory, runtimeName));
  copy(nodeLicense(nodeBinary), path.join(runtimeDirectory, 'LICENSE-node.txt'));
  if (platform !== 'win32') fs.chmodSync(path.join(runtimeDirectory, runtimeName), 0o755);

  if (platform === 'win32') {
    fs.writeFileSync(path.join(destination, 'devmate.cmd'), launcherContent(platform, 'scripts/devmate-command.mjs'), 'utf8');
    fs.writeFileSync(path.join(destination, 'devmate-runner.cmd'), launcherContent(platform, 'scripts/devmate-runner.mjs'), 'utf8');
  } else {
    writeExecutable(path.join(destination, 'devmate'), launcherContent(platform, 'scripts/devmate-command.mjs'));
    writeExecutable(path.join(destination, 'devmate-runner'), launcherContent(platform, 'scripts/devmate-runner.mjs'));
  }

  const manifest = {
    name: 'DevMate Portable CLI',
    version: packageJson.version,
    platform,
    arch,
    bundledNode: path.basename(nodeBinary),
    entry: platform === 'win32' ? 'devmate.cmd' : 'devmate',
    runnerEntry: platform === 'win32' ? 'devmate-runner.cmd' : 'devmate-runner'
  };
  fs.writeFileSync(path.join(destination, 'portable.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { destination, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    const result = packagePortable(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`DevMate portable package: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

export const __test = { launcherContent, nodeLicense, targetArch, targetPlatform };
