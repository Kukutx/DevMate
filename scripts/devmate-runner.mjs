#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) output[key] = true;
    else { output[key] = next; index += 1; }
  }
  return output;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function normalizeControlUrl(value, allowHttp = false) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Runner control URL is required through --control-url or DEVMATE_RUNNER_CONTROL_URL');
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(candidate);
  const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:') && !(local && url.protocol === 'http:')) {
    throw new Error('External Runner control URL must use HTTPS; HTTP is allowed only for loopback or with --allow-http');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Runner control URL must not include credentials, query, or fragment');
  return `${url.protocol}//${url.host}`;
}

function runnerToken(options) {
  const environment = process.env.DEVMATE_RUNNER_TOKEN || '';
  if (environment) return environment.trim();
  const tokenFile = String(options['token-file'] || process.env.DEVMATE_RUNNER_TOKEN_FILE || '').trim();
  if (tokenFile) return fs.readFileSync(path.resolve(tokenFile), 'utf8').trim();
  throw new Error('Runner token is required in DEVMATE_RUNNER_TOKEN or --token-file. Command-line token values are intentionally unsupported.');
}

function gatewayScript(options) {
  if (options['gateway-script']) return path.resolve(String(options['gateway-script']));
  const bundle = path.join(root, 'gateway', 'server.bundle.mjs');
  if (fs.existsSync(bundle)) return bundle;
  return path.join(root, 'gateway', 'server-entry.mjs');
}

function customCapabilities(options) {
  return String(options.capabilities || process.env.DEVMATE_RUNNER_CAPABILITIES || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

function runnerCapabilities(config, options = {}) {
  const output = new Set(['core', 'external', ...customCapabilities(options)]);
  const enabled = new Set(config.plugins?.enabled || []);
  if (enabled.has('devmate.browser-qa')) output.add('browser-qa');
  if (enabled.has('devmate.godot')) { output.add('godot'); output.add('browser-qa'); }
  return [...output].sort();
}

function runnerMetadata(config, options) {
  return {
    version: config.appVersion || 'unknown',
    platform: process.platform,
    arch: process.arch,
    capabilities: runnerCapabilities(config, options),
    workspaceIds: (config.workspaces || []).filter(item => !item.reference && item.mode !== 'readonly').map(item => item.id),
    maxConcurrent: Math.min(16, Math.max(1, Math.trunc(Number(options.concurrency) || Number(config.runtime?.maxConcurrentJobs) || 1))),
    labels: {
      hostname: os.hostname(),
      kind: 'external',
      agentVersion: config.appVersion || 'unknown'
    }
  };
}

function publicLog(message, detail = '') {
  const suffix = detail ? ` ${detail}` : '';
  process.stdout.write(`[${new Date().toISOString()}] ${message}${suffix}\n`);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!response.ok) {
    const error = new Error(json?.error || text || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = json?.code || 'http_error';
    throw error;
  }
  return json;
}

async function waitGateway(port, child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`Local Gateway exited before becoming ready with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/control/health`);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Local Gateway did not become ready on port ${port}`);
}

function localRpcFactory(config) {
  const port = Number(config.server?.port || 8787);
  const mcpPath = config.server?.mcpPath || '/mcp';
  const token = String(config.auth?.token || '');
  if (!token) throw new Error('Runner local DevMate config must contain an owner auth token');
  let initialized = false;
  async function rpc(method, params, signal) {
    const result = await fetchJson(`http://127.0.0.1:${port}${mcpPath}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 100000000), method, params }),
      signal
    });
    if (result?.error) throw new Error(result.error.message || 'Local MCP request failed');
    return result?.result;
  }
  return {
    async initialize() {
      if (initialized) return;
      await rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'devmate-external-runner', version: config.appVersion || 'unknown' }
      });
      initialized = true;
    },
    async callTool(name, args, signal) {
      await this.initialize();
      return rpc('tools/call', { name, arguments: args || {} }, signal);
    }
  };
}

function controlClient(origin, token, metadata) {
  async function request(relative, body = {}, signal) {
    return fetchJson(`${origin}/runner/v1${relative}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'x-devmate-runner-protocol': '1'
      },
      body: JSON.stringify(body),
      signal
    });
  }
  return {
    heartbeat: () => request('/heartbeat', { runner: metadata }),
    claim: leaseSeconds => request('/jobs/claim', { runner: metadata, leaseSeconds }),
    renew: (id, leaseSeconds) => request(`/jobs/${encodeURIComponent(id)}/renew`, { leaseSeconds }),
    complete: (id, result, artifacts) => request(`/jobs/${encodeURIComponent(id)}/complete`, { result, artifacts }),
    fail: (id, error, retryable) => request(`/jobs/${encodeURIComponent(id)}/fail`, { error, retryable }),
    cancelled: (id, error) => request(`/jobs/${encodeURIComponent(id)}/cancelled`, { error })
  };
}

function toolError(result) {
  if (result?.isError !== true) return null;
  const text = Array.isArray(result.content)
    ? result.content.filter(item => item?.type === 'text').map(item => item.text).join('\n')
    : '';
  return new Error(text || 'Local MCP tool returned an error result');
}

export async function runExternalRunner(options = parseArgs(process.argv.slice(2))) {
  const rawConfigPath = String(options.config || process.env.DEVMATE_RUNNER_CONFIG || '').trim();
  if (!rawConfigPath) throw new Error('Existing local DevMate config is required through --config or DEVMATE_RUNNER_CONFIG');
  const configPath = path.resolve(rawConfigPath);
  if (!fs.statSync(configPath, { throwIfNoEntry: false })?.isFile()) throw new Error(`Runner config is not a file: ${configPath}`);
  process.env.DEVMATE_CONFIG = configPath;
  const config = loadJson(configPath);
  if ((config.deployment?.mode || 'personal') !== 'personal') {
    throw new Error('External Runner local config must use personal deployment mode. Central team policy belongs to the control-plane Gateway.');
  }
  if (config.auth?.required === false) throw new Error('External Runner local Gateway must keep owner-token authentication enabled');
  const metadata = runnerMetadata(config, options);
  if (!metadata.workspaceIds.length) throw new Error('External Runner local config must contain at least one writable workspace');
  const origin = normalizeControlUrl(options['control-url'] || process.env.DEVMATE_RUNNER_CONTROL_URL, options['allow-http'] === true);
  const token = runnerToken(options);
  const port = Number(config.server?.port || 8787);
  const leaseSeconds = Math.min(300, Math.max(30, Math.trunc(Number(options['lease-seconds']) || 90)));
  const pollMs = Math.min(30000, Math.max(500, Math.trunc(Number(options['poll-ms']) || 2000)));
  const maximum = metadata.maxConcurrent;
  const control = controlClient(origin, token, metadata);
  const local = localRpcFactory(config);
  const { indexJobArtifacts } = await import('../gateway/job-artifacts.mjs');
  const inflight = new Map();
  let child = null;
  let stopping = false;

  if (options['no-spawn'] !== true) {
    child = spawn(process.execPath, [gatewayScript(options)], {
      cwd: root,
      env: { ...process.env, DEVMATE_CONFIG: configPath },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout?.on('data', chunk => process.stdout.write(`[gateway] ${chunk}`));
    child.stderr?.on('data', chunk => process.stderr.write(`[gateway] ${chunk}`));
  }
  await waitGateway(port, child);
  await local.initialize();
  await control.heartbeat();
  publicLog('External Runner connected', `${origin} capabilities=${metadata.capabilities.join(',')} workspaces=${metadata.workspaceIds.join(',')}`);

  async function execute(job) {
    const abort = new AbortController();
    let cancelRequested = false;
    const renewEvery = Math.min(30000, Math.max(5000, Math.floor(leaseSeconds * 1000 / 3)));
    const renewTimer = setInterval(async () => {
      try {
        const response = await control.renew(job.id, leaseSeconds);
        if (response.cancelRequested) {
          cancelRequested = true;
          abort.abort(new Error('Cancellation requested by control plane'));
        }
      } catch (error) {
        publicLog('Job lease renewal failed', `${job.id}: ${error.message}`);
      }
    }, renewEvery);
    renewTimer.unref?.();
    try {
      publicLog('Job started', `${job.id} ${job.tool}`);
      const result = await local.callTool(job.tool, job.arguments || {}, abort.signal);
      const returned = toolError(result);
      if (returned) throw returned;
      const artifacts = await indexJobArtifacts(job, result);
      await control.complete(job.id, result, artifacts);
      publicLog('Job succeeded', `${job.id} artifacts=${artifacts.length}`);
    } catch (error) {
      const message = String(error?.message || error).slice(0, 4000);
      if (cancelRequested || abort.signal.aborted) {
        try { await control.cancelled(job.id, message); } catch {}
        publicLog('Job cancellation acknowledged', job.id);
      } else {
        const retryable = error?.name === 'TypeError' || /ECONN|network|fetch failed|Gateway exited/i.test(message);
        try { await control.fail(job.id, message, retryable); } catch (reportError) {
          publicLog('Job failure report failed', `${job.id}: ${reportError.message}`);
        }
        publicLog('Job failed', `${job.id}: ${message}`);
      }
    } finally {
      clearInterval(renewTimer);
      inflight.delete(job.id);
    }
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    publicLog('Runner stopping', `inflight=${inflight.size}`);
    await Promise.race([Promise.allSettled([...inflight.values()]), delay(15000)]);
    if (child && child.exitCode === null) child.kill();
  }

  process.once('SIGINT', () => { void stop().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)); });

  do {
    while (!stopping && inflight.size < maximum) {
      let response;
      try { response = await control.claim(leaseSeconds); }
      catch (error) {
        publicLog('Claim failed', error.message);
        break;
      }
      const job = response?.job;
      if (!job) break;
      const promise = execute(job);
      inflight.set(job.id, promise);
      void promise;
    }
    if (options.once === true) {
      await Promise.allSettled([...inflight.values()]);
      break;
    }
    await delay(pollMs);
  } while (!stopping);

  await stop();
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runExternalRunner().catch(error => {
    process.stderr.write(`DevMate Runner failed: ${error?.message || error}\n`);
    process.exitCode = 1;
  });
}

export const __test = { customCapabilities, normalizeControlUrl, parseArgs, runnerCapabilities, runnerMetadata, toolError };
