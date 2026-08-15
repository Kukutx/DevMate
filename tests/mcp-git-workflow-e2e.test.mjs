import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  return String(result.stdout || '').trim();
}

async function waitReady(port, child, output) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Gateway exited early: ${output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/control/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Gateway did not become ready: ${output()}`);
}

function rpcClient(port) {
  let id = 0;
  return async (method, params = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { response, text, json };
  };
}

test('MCP Git can push repeatedly, surface failures, recover, and fail closed across every save phase', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-mcp-git-'));
  const workspace = path.join(temp, 'workspace');
  const remote = path.join(temp, 'remote.git');
  const configPath = path.join(temp, 'config.json');
  fs.mkdirSync(workspace, { recursive: true });

  git(temp, ['init', '--bare', '--initial-branch=master', remote]);
  git(workspace, ['init', '--initial-branch=master']);
  git(workspace, ['config', 'user.name', 'DevMate MCP Test']);
  git(workspace, ['config', 'user.email', 'devmate-mcp-test@example.invalid']);
  git(workspace, ['remote', 'add', 'origin', remote]);
  fs.writeFileSync(path.join(workspace, 'README.md'), '# MCP Git test\n', 'utf8');
  git(workspace, ['add', 'README.md']);
  git(workspace, ['commit', '-m', 'Initial test commit']);
  git(workspace, ['push', '-u', 'origin', 'master']);

  const port = await freePort();
  const config = configStore.newInstanceConfig({ workspaceRoot: workspace, port, appVersion: '3.4.4' });
  config.permissions.confirmBeforePush = false;
  config.requestPolicy.requestTimeoutMs = 30000;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  const child = spawn(process.execPath, ['gateway/server-runtime.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DEVMATE_CONFIG: configPath },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
    fs.rmSync(temp, { recursive: true, force: true });
  });

  await waitReady(port, child, () => `${stdout}\n${stderr}`);
  const rpc = rpcClient(port);
  const init = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'mcp-git-e2e', version: '1' }
  });
  assert.equal(init.response.ok, true, init.text);
  assert.equal(init.json?.result?.serverInfo?.name, 'devmate');

  const initialStatus = await rpc('tools/call', { name: 'git_status', arguments: {} });
  assert.equal(initialStatus.response.ok, true, initialStatus.text);
  assert.notEqual(initialStatus.json?.result?.isError, true, initialStatus.text);
  assert.equal(initialStatus.json?.result?.structuredContent?.exitCode, 0, initialStatus.text);

  const create = await rpc('tools/call', {
    name: 'create_file',
    arguments: { path: 'first.txt', content: 'first\n' }
  });
  assert.equal(create.response.ok, true, create.text);
  assert.notEqual(create.json?.result?.isError, true, create.text);

  const firstSave = await rpc('tools/call', {
    name: 'git_save',
    arguments: {
      message: 'MCP Git first save',
      all: true,
      push: true,
      remote: 'origin',
      branch: 'master'
    }
  });
  assert.equal(firstSave.response.ok, true, firstSave.text);
  assert.notEqual(firstSave.json?.result?.isError, true, firstSave.text);
  assert.equal(firstSave.json?.result?.structuredContent?.stage?.exitCode, 0, firstSave.text);
  assert.equal(firstSave.json?.result?.structuredContent?.commit?.exitCode, 0, firstSave.text);
  assert.equal(firstSave.json?.result?.structuredContent?.push?.exitCode, 0, firstSave.text);

  const write = await rpc('tools/call', {
    name: 'write_file',
    arguments: { path: 'first.txt', content: 'first\nsecond\n' }
  });
  assert.equal(write.response.ok, true, write.text);
  assert.notEqual(write.json?.result?.isError, true, write.text);

  const secondSave = await rpc('tools/call', {
    name: 'git_save',
    arguments: {
      message: 'MCP Git second save',
      all: true,
      push: true,
      remote: 'origin',
      branch: 'master'
    }
  });
  assert.equal(secondSave.response.ok, true, secondSave.text);
  assert.notEqual(secondSave.json?.result?.isError, true, secondSave.text);
  assert.equal(secondSave.json?.result?.structuredContent?.commit?.exitCode, 0, secondSave.text);
  assert.equal(secondSave.json?.result?.structuredContent?.push?.exitCode, 0, secondSave.text);

  const thirdCreate = await rpc('tools/call', {
    name: 'create_file',
    arguments: { path: 'third.txt', content: 'third\n' }
  });
  assert.equal(thirdCreate.response.ok, true, thirdCreate.text);
  assert.notEqual(thirdCreate.json?.result?.isError, true, thirdCreate.text);

  const failedSave = await rpc('tools/call', {
    name: 'git_save',
    arguments: {
      message: 'MCP Git failed push recovery',
      all: true,
      push: true,
      remote: 'missing-remote',
      branch: 'master'
    }
  });
  assert.equal(failedSave.response.ok, true, failedSave.text);
  assert.equal(failedSave.json?.result?.isError, true, failedSave.text);
  assert.equal(failedSave.json?.result?.structuredContent?.failedPhase, 'push', failedSave.text);
  assert.equal(failedSave.json?.result?.structuredContent?.commit?.exitCode, 0, failedSave.text);
  assert.notEqual(failedSave.json?.result?.structuredContent?.push?.exitCode, 0, failedSave.text);

  const afterFailureStatus = await rpc('tools/call', { name: 'git_status', arguments: {} });
  assert.equal(afterFailureStatus.response.ok, true, afterFailureStatus.text);
  assert.notEqual(afterFailureStatus.json?.result?.isError, true, afterFailureStatus.text);
  assert.match(afterFailureStatus.json?.result?.structuredContent?.stdout || '', /ahead 1/, afterFailureStatus.text);

  const afterFailureGateway = await rpc('tools/call', { name: 'gateway_status', arguments: {} });
  assert.equal(afterFailureGateway.response.ok, true, afterFailureGateway.text);
  assert.notEqual(afterFailureGateway.json?.result?.isError, true, afterFailureGateway.text);

  const recoveryPush = await rpc('tools/call', {
    name: 'git_push',
    arguments: { remote: 'origin', branch: 'master' }
  });
  assert.equal(recoveryPush.response.ok, true, recoveryPush.text);
  assert.notEqual(recoveryPush.json?.result?.isError, true, recoveryPush.text);
  assert.equal(recoveryPush.json?.result?.structuredContent?.exitCode, 0, recoveryPush.text);

  const finalStatus = await rpc('tools/call', { name: 'git_status', arguments: {} });
  assert.equal(finalStatus.response.ok, true, finalStatus.text);
  assert.notEqual(finalStatus.json?.result?.isError, true, finalStatus.text);
  assert.equal(finalStatus.json?.result?.structuredContent?.exitCode, 0, finalStatus.text);
  assert.equal(finalStatus.json?.result?.structuredContent?.stdout.trim(), '## master...origin/master', finalStatus.text);

  const noChangeSave = await rpc('tools/call', {
    name: 'git_save',
    arguments: {
      message: 'must not push after commit failure',
      all: true,
      push: true,
      remote: 'origin',
      branch: 'master'
    }
  });
  assert.equal(noChangeSave.response.ok, true, noChangeSave.text);
  assert.equal(noChangeSave.json?.result?.isError, true, noChangeSave.text);
  assert.equal(noChangeSave.json?.result?.structuredContent?.failedPhase, 'commit', noChangeSave.text);
  assert.equal(noChangeSave.json?.result?.structuredContent?.stage?.exitCode, 0, noChangeSave.text);
  assert.notEqual(noChangeSave.json?.result?.structuredContent?.commit?.exitCode, 0, noChangeSave.text);
  assert.equal(noChangeSave.json?.result?.structuredContent?.push, null, noChangeSave.text);

  const finalGatewayStatus = await rpc('tools/call', { name: 'gateway_status', arguments: {} });
  assert.equal(finalGatewayStatus.response.ok, true, finalGatewayStatus.text);
  assert.notEqual(finalGatewayStatus.json?.result?.isError, true, finalGatewayStatus.text);

  const localHead = git(workspace, ['rev-parse', 'HEAD']);
  const remoteHead = git(temp, ['--git-dir', remote, 'rev-parse', 'refs/heads/master']);
  assert.equal(remoteHead, localHead);
  const remoteLog = git(temp, ['--git-dir', remote, 'log', '--format=%s', '-3']);
  assert.match(remoteLog, /MCP Git failed push recovery/);
  assert.match(remoteLog, /MCP Git second save/);
  assert.match(remoteLog, /MCP Git first save/);

  fs.writeFileSync(path.join(workspace, 'prestage.txt'), 'prestage\n', 'utf8');
  git(workspace, ['add', 'prestage.txt']);
  const beforeFailedStageHead = git(workspace, ['rev-parse', 'HEAD']);
  const failedStageSave = await rpc('tools/call', {
    name: 'git_save',
    arguments: {
      message: 'must not commit after stage failure',
      paths: ['definitely-missing-path.txt'],
      all: false,
      push: false
    }
  });
  assert.equal(failedStageSave.response.ok, true, failedStageSave.text);
  assert.equal(failedStageSave.json?.result?.isError, true, failedStageSave.text);
  assert.equal(failedStageSave.json?.result?.structuredContent?.failedPhase, 'stage', failedStageSave.text);
  assert.notEqual(failedStageSave.json?.result?.structuredContent?.stage?.exitCode, 0, failedStageSave.text);
  assert.equal(failedStageSave.json?.result?.structuredContent?.commit, null, failedStageSave.text);
  assert.equal(failedStageSave.json?.result?.structuredContent?.push, null, failedStageSave.text);
  assert.equal(git(workspace, ['rev-parse', 'HEAD']), beforeFailedStageHead, 'failed stage must not create a commit');
  assert.match(git(workspace, ['diff', '--cached', '--name-only']), /prestage\.txt/, 'pre-existing staged work must remain staged');

  const indexLock = path.join(workspace, '.git', 'index.lock');
  fs.writeFileSync(indexLock, 'intentional test lock\n', 'utf8');
  let failedCommitStage;
  try {
    failedCommitStage = await rpc('tools/call', {
      name: 'git_commit',
      arguments: {
        message: 'must not commit after git_commit stage failure',
        all: true
      }
    });
  } finally {
    fs.rmSync(indexLock, { force: true });
  }
  assert.equal(failedCommitStage.response.ok, true, failedCommitStage.text);
  assert.equal(failedCommitStage.json?.result?.isError, true, failedCommitStage.text);
  assert.equal(failedCommitStage.json?.result?.structuredContent?.failedPhase, 'stage', failedCommitStage.text);
  assert.notEqual(failedCommitStage.json?.result?.structuredContent?.stage?.exitCode, 0, failedCommitStage.text);
  assert.equal(failedCommitStage.json?.result?.structuredContent?.commit, null, failedCommitStage.text);
  assert.equal(git(workspace, ['rev-parse', 'HEAD']), beforeFailedStageHead, 'git_commit stage failure must not create a commit');
  assert.match(git(workspace, ['diff', '--cached', '--name-only']), /prestage\.txt/, 'git_commit stage failure must preserve existing staged work');
}, { timeout: 60000 });
