import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const supervisorUrl = new URL('../gateway/agent-codex-supervisor.mjs', import.meta.url);
const supervisorPath = fileURLToPath(supervisorUrl);

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function waitForMessage(child, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for Codex supervisor message'));
    }, timeoutMs);
    const onMessage = message => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Codex supervisor exited before ready (${code ?? 'null'}, ${signal || 'none'})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

function waitForExit(child, timeoutMs = 10000) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('Timed out waiting for Codex supervisor exit'));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
  });
}

test('Codex supervisor source keeps its lifetime fence until child cleanup is confirmed', async () => {
  const source = await fsp.readFile(supervisorUrl, 'utf8');
  assert.match(source, /while \(childActive\(current\)\)/);
  assert.match(source, /const result = await terminateProcessTree\(current, CLEANUP\)/);
  assert.match(source, /if \(!confirmed\)[\s\S]*await delay\(CLEANUP_RETRY_MS\)/);
  assert.match(source, /exitConfirmed: true/);
  assert.doesNotMatch(source, /exitConfirmed === false[\s\S]{0,600}process\.exit/);
});

test('Codex supervisor terminates its app-server child when the Gateway IPC parent disappears', async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-codex-supervisor-'));
  const providerScript = path.join(temp, 'fake-codex-child.mjs');
  const pidFile = path.join(temp, 'child.pid');
  await fsp.writeFile(providerScript, [
    "import fs from 'node:fs';",
    "const pidFile = process.argv[2];",
    "fs.writeFileSync(pidFile, String(process.pid));",
    "process.on('SIGTERM', () => process.exit(0));",
    "process.on('SIGINT', () => process.exit(0));",
    "setInterval(() => {}, 1000);"
  ].join('\n'), 'utf8');

  const supervisor = spawn(process.execPath, [supervisorPath], {
    cwd: temp,
    env: {
      ...process.env,
      DEVMATE_CODEX_SUPERVISOR_EXECUTABLE: process.execPath,
      DEVMATE_CODEX_SUPERVISOR_ARGS: JSON.stringify([providerScript, pidFile])
    },
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  });
  let childPid = null;
  try {
    const started = await waitForMessage(supervisor, message => message?.type === 'devmate:codex-started');
    childPid = Number(started.pid);
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    for (let attempt = 0; attempt < 40 && !await fsp.stat(pidFile).then(() => true, () => false); attempt += 1) await delay(25);
    assert.equal(Number(await fsp.readFile(pidFile, 'utf8')), childPid);
    assert.equal(alive(childPid), true);

    supervisor.disconnect();
    const exited = await waitForExit(supervisor);
    assert.equal(exited.code, 0);
    for (let attempt = 0; attempt < 40 && alive(childPid); attempt += 1) await delay(50);
    assert.equal(alive(childPid), false, 'Codex child must not survive supervisor parent disconnect');
  } finally {
    if (supervisor.exitCode == null && supervisor.signalCode == null) supervisor.kill('SIGTERM');
    await waitForExit(supervisor, 5000).catch(() => {});
    if (childPid && alive(childPid)) {
      try { process.kill(childPid, 'SIGKILL'); } catch {}
    }
    await fsp.rm(temp, { recursive: true, force: true });
  }
}, { timeout: 20000 });