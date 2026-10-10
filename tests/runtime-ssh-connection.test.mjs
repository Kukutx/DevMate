import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSshConnection, normalizeSshConfig, sshArguments } from '../runtime/ssh-connection.mjs';
import { normalizeConfig } from '../runtime/config.mjs';
import processTree from '../runtime/platform/process-tree.js';

const run = promisify(execFile);
const nativeSsh = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : '/usr/bin/ssh';
const input = { kind: 'ssh', publicUrl: 'https://devmate.example.com/mcp', executable: nativeSsh, host: 'relay.example.com', user: 'devmate-tunnel' };
test('self-hosted SSH configuration pins the public MCP origin and rejects implicit shells or forwarding targets', () => {
  const config = normalizeConfig({ connection: input, auth: { mode: 'oauth', issuer: 'https://devmate.example.com' } });
  assert.equal(config.connection.remotePort, 18443);
  assert.throws(() => normalizeConfig({ connection: input, auth: { mode: 'oauth', issuer: 'https://different.example.com' } }), { code: 'invalid_issuer' });
  assert.throws(() => normalizeSshConfig({ ...input, host: '-oProxyCommand=bad' }), { code: 'invalid_connection' });
  assert.throws(() => normalizeSshConfig({ ...input, remotePort: 80 }), { code: 'invalid_connection' });
  assert.throws(() => normalizeSshConfig({ ...input, publicUrl: 'http://devmate.example.com/mcp' }), { code: 'invalid_connection' });
  assert.throws(() => sshArguments(config.connection, 'http://192.168.1.5:8788/mcp'), { code: 'invalid_target' });
});
test('native OpenSSH parses an isolated noninteractive reverse tunnel without contacting a server', { skip: !fs.existsSync(nativeSsh) }, async () => {
  const settings = normalizeSshConfig(input);
  const { stdout } = await run(nativeSsh, ['-G', ...sshArguments(settings, 'http://127.0.0.1:8788/mcp')], { timeout: 10000, windowsHide: true, shell: false });
  assert.match(stdout, /^hostname relay\.example\.com$/m);
  assert.match(stdout, /^user devmate-tunnel$/m);
  assert.match(stdout, /^batchmode yes$/m);
  assert.match(stdout, /^stricthostkeychecking true$/m);
  assert.match(stdout, /^exitonforwardfailure yes$/m);
  assert.match(stdout, /^controlmaster false$/m);
  assert.match(stdout, /^remoteforward .*18443.*8788$/m);
  assert.match(stdout, /^requesttty false$/m);
});
test('SSH adapter owns only its child and retains ownership until a retried stop confirms exit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-ssh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let child, calls = 0, spawnCalls = 0, captured;
  const connection = createSshConnection({ config: { ...input, executable: process.execPath }, instanceRoot: root, localMcpUrl: 'http://127.0.0.1:9123/mcp',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DEVMATE_TEST_SECRET: 'must-not-inherit' },
    spawnImpl(file, args, options) {
      spawnCalls++; captured = { args, options };
      child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, stdio: ['ignore', 'ignore', 'pipe'] });
      return child;
    },
    terminateImpl: async proc => ++calls === 1 ? { exitConfirmed: false } : processTree.terminateProcessTree(proc)
  });
  t.after(async () => { if (child && !processTree.childExited(child)) await processTree.terminateProcessTree(child); });
  const started = await connection.start();
  assert.equal(started.phase, 'process-running');
  assert.equal(started.remoteMcpVerified, false);
  assert.equal(captured.options.shell, false);
  assert.equal(captured.options.env.DEVMATE_TEST_SECRET, undefined);
  assert.ok(captured.args.includes('127.0.0.1:18443:127.0.0.1:9123'));
  const pid = child.pid;
  await assert.rejects(connection.stop(), { code: 'shutdown_unconfirmed' });
  assert.equal(connection.status().pid, pid);
  await connection.start();
  assert.equal(spawnCalls, 1);
  assert.equal((await connection.stop()).phase, 'stopped');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
