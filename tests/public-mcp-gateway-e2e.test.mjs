import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseJsonPayload, preflightPublicMcp } = require('../host/public-mcp.js');

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

test('public preflight closes direct no-auth initialize, tools/list, and tools/call against the real Gateway', async () => {
  const root = process.cwd();
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-public-preflight-'));
  const workspaceRoot = path.join(temp, 'workspace');
  const configPath = path.join(temp, 'config.json');
  const port = await freePort();
  await fsp.mkdir(workspaceRoot, { recursive: true });

  const config = {
    version: 11,
    appVersion: '3.4.4',
    instanceId: `public-preflight-${Date.now()}`,
    server: { port, mcpPath: '/mcp' },
    runtime: { defaultCommandTimeoutMs: 30000, maxOutputChars: 80000, maxConcurrentJobs: 2 },
    maintenance: { backupRetentionDays: 30, auditRetentionDays: 30, maxBackupBytes: 268435456, maxAuditBytes: 5242880 },
    connection: { provider: 'ngrok', publicUrl: '' },
    auth: { mode: 'none' },
    permissions: { profile: 'fullAccess', readOnly: false, blockDangerousOperations: true, confirmBeforePush: true, allowDirectoryMutations: false },
    team: { members: [], requireWorkspaceLeaseForWrites: false, defaultMemberRole: 'developer', maxMembers: 100, approvals: { enabled: false, requiredCapabilities: [], requiredTools: [], separationOfDuties: true } },
    requestPolicy: { allowedHosts: [], maxRequestBytes: 2097152, requestsPerMinute: 120, maxConcurrentRequests: 24, maxConcurrentPerPrincipal: 4, requestTimeoutMs: 900000 },
    jobs: { embeddedRunnerEnabled: true, allowJobGitSave: true },
    runnerControl: { enabled: false, credentials: [] },
    activeWorkspaceId: 'app',
    workspaces: [{ id: 'app', name: 'Application', root: workspaceRoot, mode: 'workspace-write', reference: false, role: 'active' }],
    commands: [],
    plugins: { enabled: [], settings: {} }
  };
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

  const child = spawn(process.execPath, ['gateway/server-runtime.mjs'], {
    cwd: root,
    env: { ...process.env, DEVMATE_CONFIG: configPath },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  try {
    let ready = false;
    for (let index = 0; index < 60; index += 1) {
      await delay(200);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/control/health`);
        const json = await response.json();
        if (response.ok && json?.instanceId === config.instanceId) {
          ready = true;
          break;
        }
      } catch {}
    }
    assert.equal(ready, true, `Gateway did not become ready.\nstdout=${stdout}\nstderr=${stderr}`);

    const request = async (_publicUrl, options) => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: options.method,
        headers: options.headers,
        body: options.body
      });
      const body = await response.text();
      const headers = Object.fromEntries([...response.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
      return {
        ok: response.ok,
        status: response.status,
        headers,
        body,
        json: parseJsonPayload(body),
        bytes: Buffer.byteLength(body)
      };
    };

    const result = await preflightPublicMcp({
      publicUrl: 'https://devmate-public.example',
      token: '',
      clientName: 'devmate-public-e2e',
      clientVersion: '3.4.4',
      request
    });

    assert.equal(result.server?.name, 'devmate');
    assert.ok(result.toolCount > 0);
    assert.equal(result.mcpUrl, 'https://devmate-public.example/mcp');
    assert.equal(result.toolCallVerified, true);
    assert.equal(result.probeTool, 'gateway_status');
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
    }
    await fsp.rm(temp, { recursive: true, force: true });
  }
}, { timeout: 30000 });
