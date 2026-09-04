'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SUPPORTED_CONFIG_VERSION, atomicWriteJson } = require('../shared/config-store.cjs');
const {
  mergeExtensionConfig,
  mergeHostContexts,
  readExtensionConfig
} = require('../vscode-host/config-sync.js');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (fs.existsSync(file)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function waitForExit(child) {
  if (child.exitCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`child exited with code=${child.exitCode} signal=${child.signalCode || ''}`));
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited with code=${code} signal=${signal || ''}`));
    });
  });
}

test('timestamp-only VS Code context refreshes preserve the existing host record', () => {
  const current = {
    vscode: {
      capturedAt: '2026-09-04T10:00:00.000Z',
      updatedAt: '2026-09-04T10:00:00.000Z',
      workspaceRoot: '/workspace/app',
      activeEditor: { path: 'src/app.js', languageId: 'javascript' },
      visibleEditors: [{ path: 'src/app.js', languageId: 'javascript' }],
      diagnostics: []
    }
  };
  const candidate = {
    vscode: {
      ...current.vscode,
      capturedAt: '2026-09-04T10:00:10.000Z',
      updatedAt: '2026-09-04T10:00:10.000Z'
    }
  };

  const merged = mergeHostContexts(current, candidate);
  assert.equal(merged.vscode, current.vscode);
  assert.equal(merged.vscode.updatedAt, '2026-09-04T10:00:00.000Z');
});

test('a semantic VS Code context change still advances the host record', () => {
  const current = {
    vscode: {
      capturedAt: 'old',
      updatedAt: 'old',
      workspaceRoot: '/workspace/app',
      activeEditor: { path: 'src/app.js', languageId: 'javascript' }
    }
  };
  const candidate = {
    vscode: {
      capturedAt: 'new',
      updatedAt: 'new',
      workspaceRoot: '/workspace/app',
      activeEditor: { path: 'src/other.js', languageId: 'javascript' }
    }
  };

  const merged = mergeHostContexts(current, candidate);
  assert.equal(merged.vscode, candidate.vscode);
  assert.equal(merged.vscode.activeEditor.path, 'src/other.js');
});

test('a real active-host handoff refreshes freshness even when editor semantics are unchanged', () => {
  const currentContext = {
    capturedAt: 'old',
    updatedAt: 'old',
    hostId: 'vscode',
    kind: 'editor',
    workspaceRoot: '/workspace/app',
    activeEditor: { path: 'src/app.js', languageId: 'javascript' }
  };
  const candidateContext = { ...currentContext, capturedAt: 'new', updatedAt: 'new' };
  const merged = mergeExtensionConfig({
    version: SUPPORTED_CONFIG_VERSION,
    activeHostId: 'obsidian',
    hostContexts: { vscode: currentContext, obsidian: { hostId: 'obsidian', updatedAt: 'middle' } }
  }, {
    version: SUPPORTED_CONFIG_VERSION,
    activeHostId: 'vscode',
    hostContexts: { vscode: candidateContext }
  });

  assert.equal(merged.activeHostId, 'vscode');
  assert.equal(merged.hostContexts.vscode, candidateContext);
  assert.equal(merged.hostContexts.vscode.updatedAt, 'new');
});

test('authoritative VS Code config reads wait out an in-progress replacement window', async t => {
  const directory = temporaryDirectory('devmate-config-read-race-');
  const file = path.join(directory, 'config.json');
  const marker = path.join(directory, 'replacement-open');
  atomicWriteJson(file, {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'stable-instance',
    server: { port: 8787, mcpPath: '/mcp' },
    auth: { mode: 'none' },
    connection: { provider: 'ngrok', publicUrl: '' },
    workspaces: []
  });

  const lockModule = path.resolve(__dirname, '..', 'config-file-lock.cjs');
  const childScript = `
    const fs = require('node:fs');
    const { acquireFileLock, releaseFileLock } = require(process.argv[1]);
    const file = process.argv[2];
    const marker = process.argv[3];
    const replacement = file + '.replace-race';
    const lock = acquireFileLock(file);
    try {
      fs.renameSync(file, replacement);
      fs.writeFileSync(marker, 'open', 'utf8');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      fs.renameSync(replacement, file);
    } finally {
      releaseFileLock(lock);
    }
  `;
  const child = spawn(process.execPath, ['-e', childScript, lockModule, file, marker], {
    stdio: 'ignore'
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await waitForFile(marker);
  const config = readExtensionConfig(file);
  assert.equal(config?.instanceId, 'stable-instance');
  assert.equal(config?.version, SUPPORTED_CONFIG_VERSION);
  await waitForExit(child);
});
