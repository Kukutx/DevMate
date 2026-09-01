#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next) throw new Error(`Missing value for --${key}`);
    options[key] = next;
    index += 1;
  }
  return options;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function launcher(root) {
  return process.platform === 'win32' ? path.join(root, 'devmate.cmd') : path.join(root, 'devmate');
}

function invoke(root, args, { json = true, allowFailure = false } = {}) {
  const entry = launcher(root);
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : entry;
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', entry, ...args]
    : args;
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
    env: { ...process.env, NO_COLOR: '1' }
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`Portable command failed: ${args.join(' ')}\n${result.stderr || result.stdout || result.error?.message || ''}`);
  }
  if (!json) return result;
  try { return JSON.parse(String(result.stdout || '').trim()); }
  catch (error) {
    throw new Error(`Portable command returned invalid JSON: ${args.join(' ')}\n${result.stdout}\n${error.message}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const portableRoot = path.resolve(String(options.root || ''));
  if (!fs.statSync(launcher(portableRoot), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Portable DevMate launcher is missing: ${launcher(portableRoot)}`);
  }

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-portable-smoke-'));
  const workspace = path.join(temporary, 'workspace one');
  const secondWorkspace = path.join(temporary, 'workspace two');
  const state = path.join(temporary, 'state');
  const config = path.join(state, 'config.json');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(secondWorkspace, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const port = await freePort();
  let running = false;

  try {
    const initialized = invoke(portableRoot, [
      'init', '--workspace', workspace, '--config', config,
      '--provider', 'ngrok', '--authentication-mode', 'none', '--port', String(port)
    ]);
    assert.equal(initialized.ok, true);
    assert.equal(path.resolve(initialized.config), path.resolve(config));

    const added = invoke(portableRoot, ['workspace', 'add', secondWorkspace, '--use', '--config', config]);
    assert.equal(path.resolve(added.added.root), path.resolve(secondWorkspace));
    assert.equal(added.added.active, true);

    const started = invoke(portableRoot, ['start', '--config', config]);
    running = true;
    assert.equal(started.ok, true);
    assert.equal(started.started, true);
    assert.match(String(started.owner || ''), /^cli-daemon-/);

    const status = invoke(portableRoot, ['runtime-status', '--config', config]);
    assert.equal(status.running, true);
    assert.equal(status.cliOwned, true);
    assert.equal(status.port, port);

    const tools = invoke(portableRoot, ['tool', 'list', '--config', config]);
    assert.ok(tools.tools.some(item => item.name === 'gateway_status'));
    assert.ok(tools.tools.length > 10);

    const gateway = invoke(portableRoot, ['tool', 'call', 'gateway_status', '--args', '{}', '--config', config]);
    assert.ok(Array.isArray(gateway.content));

    const stopped = invoke(portableRoot, ['stop', '--config', config]);
    running = false;
    assert.equal(stopped.ok, true);
    assert.equal(stopped.stopped, true);

    const final = invoke(portableRoot, ['runtime-status', '--config', config]);
    assert.equal(final.running, false);
    console.log(JSON.stringify({ ok: true, portableRoot, port, toolCount: tools.tools.length }, null, 2));
  } finally {
    if (running) invoke(portableRoot, ['stop', '--config', config], { allowFailure: true });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Portable DevMate smoke failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
