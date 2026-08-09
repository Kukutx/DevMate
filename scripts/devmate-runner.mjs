#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import configStore from '../shared/config-store.cjs';
import { terminateProcessTree } from '../gateway/command-process.mjs';
import {
  booleanFlag,
  integerOption,
  integerValue,
  jobTimeout,
  parseRunnerArgs,
  stringValue
} from './runner-options.mjs';

const { readJson: readConfigJson } = configStore;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_SECRET_ENV = [
  'DEVMATE_RUNNER_TOKEN',
  'DEVMATE_RUNNER_TOKEN_FILE',
  'DEVMATE_RUNNER_CONTROL_URL',
  'DEVMATE_RUNNER_CONFIG',
  'DEVMATE_RUNNER_CAPABILITIES'
];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadConfig(file) {
  return readConfigJson(file, null, { strict: true, supportedVersion: true });
}

function normalizeControlUrl(value, allowHttp = false) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Runner control URL is required through --control-url or DEVMATE_RUNNER_CONTROL_URL');
  }
  const raw = value.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(candidate);
  const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:') && !(local && url.protocol === 'http:')) {
    throw new Error('External Runner control URL must use HTTPS; HTTP is allowed only for loopback or with --allow-http');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Runner control URL must not include credentials, query, or fragment');
  if (url.pathname && url.pathname !== '/') throw new Error('Runner control URL must be an origin without a path');
  return `${url.protocol}//${url.host}`;
}

function runnerToken(options) {
  const environment = process.env.DEVMATE_RUNNER_TOKEN;
  if (environment !== undefined) {
    if (!environment.trim()) throw new Error('DEVMATE_RUNNER_TOKEN must not be empty');
    return environment.trim();
  }
  const rawTokenFile = options['token-file'] ?? process.env.DEVMATE_RUNNER_TOKEN_FILE;
  if (rawTokenFile !== undefined) {
    const tokenFile = stringValue(rawTokenFile, undefined, 'Runner token file');
    const token = fs.readFileSync(path.resolve(tokenFile), 'utf8').trim();
    if (!token) throw new Error('Runner token file is empty');
    return token;
  }
  throw new Error('Runner token is required in DEVMATE_RUNNER_TOKEN or --token-file. Command-line token values are intentionally unsupported.');
}

function gatewayEnvironment(configPath) {
  const environment = {
    ...process.env,
    DEVMATE_CONFIG: configPath,
    DEVMATE_DISABLE_EMBEDDED_RUNNER: '1',
    DEVMATE_BIND_HOST: '127.0.0.1'
  };
  for (const key of RUNNER_SECRET_ENV) delete environment[key];
  return environment;
}

function clearRunnerSecretsFromProcess() {
  for (const key of RUNNER_SECRET_ENV) delete process.env[key];
}

function gatewayScript(options) {
  if (options['gateway-script'] !== undefined) return path.resolve(stringValue(options['gateway-script'], undefined, '--gateway-script'));
  const bundle = path.join(root, 'gateway', 'server.bundle.mjs');
  if (fs.existsSync(bundle)) return bundle;
  return path.join(root, 'gateway', 'server-entry.mjs');
}

function customCapabilities(options) {
  const raw = options.capabilities ?? process.env.DEVMATE_RUNNER_CAPABILITIES;
  if (raw === undefined) return [];
  if (typeof raw !== 'string') throw new Error('Runner capabilities must be a comma-separated string');
  const capabilities = raw.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!capabilities.length) throw new Error('Runner capabilities must contain at least one capability when provided');
  return [...new Set(capabilities)];
}

function runnerCapabilities(config, options = {}) {
  const output = new Set(['core', 'external', ...customCapabilities(options)]);
  const enabledPlugins = config.plugins?.enabled;
  if (enabledPlugins !== undefined && !Array.isArray(enabledPlugins)) throw new Error('plugins.enabled must be an array');
  const enabled = new Set((enabledPlugins || []).map(value => {
    if (typeof value !== 'string') throw new Error('plugins.enabled must contain only strings');
    return value;
  }));
  if (enabled.has('devmate.browser-qa')) output.add('browser-qa');
  if (enabled.has('devmate.godot')) {
    output.add('godot');
    output.add('browser-qa');
  }
  return [...output].sort();
}

function runnerWorkspaceIds(config) {
  if (!Array.isArray(config.workspaces)) throw new Error('Runner config workspaces must be an array');
  const ids = [];
  const seen = new Set();
  for (const item of config.workspaces) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Runner workspace entries must be objects');
    if (item.reference || item.mode === 'readonly') continue;
    if (typeof item.id !== 'string' || !item.id.trim()) throw new Error('Writable Runner workspaces require a non-empty id');
    const id = item.id.trim();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function runnerMetadata(config, options) {
  const defaultConcurrency = integerValue(config.runtime?.maxConcurrentJobs, 1, 1, 8, 'runtime.maxConcurrentJobs');
  return {
    version: typeof config.appVersion === 'string' && config.appVersion ? config.appVersion : 'unknown',
    platform: process.platform,
    arch: process.arch,
    capabilities: runnerCapabilities(config, options),
    workspaceIds: runnerWorkspaceIds(config),
    maxConcurrent: integerOption(options.concurrency, defaultConcurrency, 1, 16, '--concurrency'),
    labels: {
      hostname: os.hostname(),
      kind: 'external',
      agentVersion: typeof config.appVersion === 'string' && config.appVersion ? config.appVersion : 'unknown'
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
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`Local Gateway exited before becoming ready with code ${child.exitCode ?? 'null'}${child.signalCode ? ` signal ${child.signalCode}` : ''}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/control/health`);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Local Gateway did not become ready on port ${port}`);
}

function localMcpClient(config) {
  const port = integerValue(config.server?.port, 8787, 1, 65535, 'server.port');
  const mcpPath = config.server?.mcpPath === undefined ? '/mcp' : config.server.mcpPath;
  if (typeof mcpPath !== 'string' || !mcpPath.startsWith('/')) throw new Error('server.mcpPath must be an absolute path');
  const token = config.auth?.token;
  if (typeof token !== 'string' || !token) throw new Error('Runner local DevMate config must contain an owner auth token');
  let client = null;
  let transport = null;
  let connecting = null;
  async function initialize() {
    if (client) return;
    if (connecting) return connecting;
    connecting = (async () => {
      const nextTransport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}${mcpPath}`),
        { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
      );
      const nextClient = new Client(
        { name: 'devmate-external-runner', version: config.appVersion || 'unknown' },
        { capabilities: {} }
      );
      await nextClient.connect(nextTransport, { timeout: 30000 });
      transport = nextTransport;
      client = nextClient;
    })();
    try { await connecting; }
    finally { connecting = null; }
  }
  return {
    initialize,
    async callTool(name, args, signal, timeout) {
      await initialize();
      const timeoutMs = jobTimeout(timeout);
      return client.callTool(
        { name, arguments: args || {} },
        undefined,
        { signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs }
      );
    },
    async close() {
      const currentClient = client;
      client = null;
      transport = null;
      if (currentClient) await currentClient.close();
    },
    status() {
      return { connected: !!client, transport: transport ? 'streamable-http' : null };
    }
  };
}

function claimBody(job, body = {}) {
  const claim = job?.claim;
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new Error(`Job ${job?.id || '(unknown)'} is missing Runner claim proof`);
  if (!Number.isInteger(claim.generation) || claim.generation < 1) throw new Error(`Job ${job?.id || '(unknown)'} has an invalid claim generation`);
  if (typeof claim.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(claim.token)) throw new Error(`Job ${job?.id || '(unknown)'} has an invalid claim token`);
  return {
    ...body,
    claimGeneration: claim.generation,
    claimToken: claim.token
  };
}

function ownershipLostError(error) {
  return Number(error?.status) === 409 || [
    'claim_fence_invalid',
    'claim_fence_expired',
    'job_not_owned'
  ].includes(String(error?.code || ''));
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
    renew: (job, leaseSeconds) => request(`/jobs/${encodeURIComponent(job.id)}/renew`, claimBody(job, { leaseSeconds })),
    complete: (job, result, artifacts) => request(`/jobs/${encodeURIComponent(job.id)}/complete`, claimBody(job, { result, artifacts })),
    fail: (job, error, retryable) => request(`/jobs/${encodeURIComponent(job.id)}/fail`, claimBody(job, { error, retryable })),
    cancelled: (job, error) => request(`/jobs/${encodeURIComponent(job.id)}/cancelled`, claimBody(job, { error }))
  };
}

function toolError(result) {
  if (result?.isError !== true) return null;
  const text = Array.isArray(result.content)
    ? result.content.filter(item => item?.type === 'text').map(item => item.text).join('\n')
    : '';
  return new Error(text || 'Local MCP tool returned an error result');
}

export async function runExternalRunner(options = parseRunnerArgs(process.argv.slice(2))) {
  const configInput = options.config ?? process.env.DEVMATE_RUNNER_CONFIG;
  if (configInput === undefined) throw new Error('Existing local DevMate config is required through --config or DEVMATE_RUNNER_CONFIG');
  const configPath = path.resolve(stringValue(configInput, undefined, 'Runner config path'));
  if (!fs.statSync(configPath, { throwIfNoEntry: false })?.isFile()) throw new Error(`Runner config is not a file: ${configPath}`);
  process.env.DEVMATE_CONFIG = configPath;
  const config = loadConfig(configPath);
  if (config.auth?.required === false) throw new Error('External Runner local Gateway must keep owner-token authentication enabled');
  const metadata = runnerMetadata(config, options);
  if (!metadata.workspaceIds.length) throw new Error('External Runner local config must contain at least one writable workspace');
  const allowHttp = booleanFlag(options['allow-http'], '--allow-http');
  const noSpawn = booleanFlag(options['no-spawn'], '--no-spawn');
  const once = booleanFlag(options.once, '--once');
  const controlInput = options['control-url'] ?? process.env.DEVMATE_RUNNER_CONTROL_URL;
  const origin = normalizeControlUrl(controlInput, allowHttp);
  const token = runnerToken(options);
  const childEnvironment = gatewayEnvironment(configPath);
  clearRunnerSecretsFromProcess();
  const port = integerValue(config.server?.port, 8787, 1, 65535, 'server.port');
  const leaseSeconds = integerOption(options['lease-seconds'], 90, 15, 300, '--lease-seconds');
  const pollMs = integerOption(options['poll-ms'], 2000, 500, 30000, '--poll-ms');
  const maximum = metadata.maxConcurrent;
  const control = controlClient(origin, token, metadata);
  const local = localMcpClient(config);
  const { indexJobArtifacts } = await import('../gateway/job-artifacts.mjs');
  const inflight = new Map();
  let child = null;
  let stopping = false;

  if (!noSpawn) {
    child = spawn(process.execPath, [gatewayScript(options)], {
      cwd: root,
      env: childEnvironment,
      windowsHide: true,
      detached: process.platform !== 'win32',
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
    let ownershipLost = false;
    let renewalInFlight = null;
    const renewEvery = Math.min(30000, Math.max(5000, Math.floor(leaseSeconds * 1000 / 3)));
    const renew = async () => {
      if (renewalInFlight) return renewalInFlight;
      renewalInFlight = (async () => {
        try {
          const response = await control.renew(job, leaseSeconds);
          if (response.cancelRequested) {
            cancelRequested = true;
            abort.abort(new Error('Cancellation requested by control plane'));
          }
        } catch (error) {
          if (ownershipLostError(error)) {
            ownershipLost = true;
            abort.abort(new Error('Job ownership was lost to another claim'));
            publicLog('Job ownership lost', `${job.id}: ${error.message}`);
          } else {
            publicLog('Job lease renewal failed', `${job.id}: ${error.message}`);
          }
        }
      })();
      try { await renewalInFlight; }
      finally { renewalInFlight = null; }
    };
    const renewTimer = setInterval(() => { void renew(); }, renewEvery);
    renewTimer.unref?.();
    try {
      publicLog('Job started', `${job.id} ${job.tool}`);
      const result = await local.callTool(job.tool, job.arguments || {}, abort.signal, job.timeoutMs);
      if (renewalInFlight) await renewalInFlight;
      if (ownershipLost) throw Object.assign(new Error('Job ownership was lost before completion'), { code: 'job_ownership_lost' });
      const returned = toolError(result);
      if (returned) throw returned;
      const artifacts = await indexJobArtifacts(job, result);
      await control.complete(job, result, artifacts);
      publicLog('Job succeeded', `${job.id} artifacts=${artifacts.length}`);
    } catch (error) {
      const message = String(error?.message || error).slice(0, 4000);
      if (ownershipLost || error?.code === 'job_ownership_lost') {
        publicLog('Stale Job result discarded', job.id);
      } else if (cancelRequested || abort.signal.aborted) {
        try { await control.cancelled(job, message); } catch {}
        publicLog('Job cancellation acknowledged', job.id);
      } else {
        const retryable = error?.name === 'TypeError' || /ECONN|network|fetch failed|Gateway exited/i.test(message);
        try { await control.fail(job, message, retryable); } catch (reportError) {
          publicLog('Job failure report failed', `${job.id}: ${reportError.message}`);
        }
        publicLog('Job failed', `${job.id}: ${message}`);
      }
    } finally {
      clearInterval(renewTimer);
      if (renewalInFlight) await renewalInFlight.catch(() => {});
      inflight.delete(job.id);
    }
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    publicLog('Runner stopping', `inflight=${inflight.size}`);
    await Promise.race([Promise.allSettled([...inflight.values()]), delay(15000)]);
    try { await local.close(); } catch {}
    if (child && child.exitCode === null) await terminateProcessTree(child);
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
    if (once) {
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

export const __test = {
  claimBody,
  clearRunnerSecretsFromProcess,
  customCapabilities,
  gatewayEnvironment,
  localMcpClient,
  normalizeControlUrl,
  ownershipLostError,
  runnerCapabilities,
  runnerMetadata,
  runnerToken,
  runnerWorkspaceIds,
  toolError
};
