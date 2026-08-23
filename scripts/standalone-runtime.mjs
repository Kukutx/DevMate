import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import configStore from '../shared/config-store.cjs';
import oauthSecrets from '../shared/oauth-secrets.cjs';
import instanceConfig from '../shared/instance-config.cjs';
import portConfig from '../shared/port.cjs';
import {
  createTeamMember,
  memberPublic,
  normalizeInstanceConfig,
  revokeTeamMember,
  rotateTeamMemberLoginCode
} from '../gateway/team-access.mjs';

const { DEFAULT_VERSION, configureAuthentication, newInstanceConfig, readJson: readConfigJson, updateConfig } = configStore;
const { ensureOAuthSecrets, readOAuthSecrets } = oauthSecrets;
const { CONNECTION_PROVIDERS } = instanceConfig;
const { parsePortOption } = portConfig;

export function configFile(options = {}) {
  return path.resolve(String(options.config || process.env.DEVMATE_CONFIG || path.join(process.cwd(), '.devmate-server', 'config.json')));
}

export function readConfig(file) {
  return readConfigJson(file, null, { strict: true, supportedVersion: true });
}

export function cleanProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (!CONNECTION_PROVIDERS.includes(provider)) throw new Error(`Unknown connection provider: ${value}`);
  return provider;
}

export function normalizeOrigin(value, { httpsOnly = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(candidate);
  if (
    !['http:', 'https:'].includes(url.protocol) || (httpsOnly && url.protocol !== 'https:') || !url.hostname ||
    url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')
  ) {
    throw new Error(httpsOnly ? 'public URL must be a clean HTTPS origin' : 'public URL must be a clean HTTP(S) origin');
  }
  return `${url.protocol}//${url.host}`;
}

export function validateStandaloneIngress({ provider, publicUrl }) {
  const normalizedProvider = cleanProvider(provider);
  const normalizedUrl = publicUrl ? normalizeOrigin(publicUrl, { httpsOnly: true }) : '';
  if ((normalizedProvider === 'cloudflare-managed' || normalizedProvider === 'external') && !normalizedUrl) {
    throw new Error(`${normalizedProvider} requires --public-url with a stable HTTPS origin`);
  }
  return { provider: normalizedProvider, publicUrl: normalizedUrl };
}

function optionalInteger(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return numeric;
}

function optionalBoolean(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${label} must be a boolean`);
}

export function initConfig(options = {}) {
  const file = configFile(options);
  if (fs.existsSync(file) && options.force !== true && options.force !== 'true') {
    throw new Error(`Config already exists: ${file}. Pass --force to replace it.`);
  }
  const workspace = path.resolve(String(options.workspace || process.cwd()));
  if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Workspace is not a directory: ${workspace}`);

  const provider = cleanProvider(String(options.provider || 'ngrok'));
  const port = parsePortOption(options.port, { label: '--port' });
  const rawPublicUrl = String(options['public-url'] || '').trim();
  const publicUrl = rawPublicUrl ? normalizeOrigin(rawPublicUrl, { httpsOnly: true }) : '';
  validateStandaloneIngress({ provider, publicUrl });
  const requestedAuthentication = options['authentication-mode'] === undefined
    ? 'oauth'
    : String(options['authentication-mode']).trim().toLowerCase();
  if (publicUrl && requestedAuthentication !== 'oauth') {
    throw new Error('Public HTTPS ingress requires --authentication-mode oauth; none is loopback-only');
  }

  const config = newInstanceConfig({ workspaceRoot: workspace, port, appVersion: DEFAULT_VERSION });
  config.instanceId = `standalone-${Date.now().toString(36)}`;
  config.activeWorkspaceId = 'workspace';
  config.workspaces[0].id = 'workspace';
  config.connection.provider = provider;
  config.connection.publicUrl = publicUrl;
  configureAuthentication(config, requestedAuthentication);
  config.team.requireWorkspaceLeaseForWrites = optionalBoolean(
    options['require-workspace-lease-for-writes'],
    config.team.requireWorkspaceLeaseForWrites,
    '--require-workspace-lease-for-writes'
  );
  config.jobs.embeddedRunnerEnabled = optionalBoolean(
    options['embedded-runner'],
    config.jobs.embeddedRunnerEnabled,
    '--embedded-runner'
  );
  config.runtime.maxConcurrentJobs = optionalInteger(
    options['max-concurrent-jobs'],
    config.runtime.maxConcurrentJobs,
    1,
    8,
    '--max-concurrent-jobs'
  );
  config.requestPolicy.requestsPerMinute = optionalInteger(
    options['requests-per-minute'],
    config.requestPolicy.requestsPerMinute,
    10,
    10000,
    '--requests-per-minute'
  );
  config.requestPolicy.maxConcurrentRequests = optionalInteger(
    options['max-concurrent-requests'],
    config.requestPolicy.maxConcurrentRequests,
    1,
    256,
    '--max-concurrent-requests'
  );
  config.requestPolicy.maxConcurrentPerPrincipal = optionalInteger(
    options['max-concurrent-per-principal'],
    config.requestPolicy.maxConcurrentPerPrincipal,
    1,
    64,
    '--max-concurrent-per-principal'
  );
  config.requestPolicy.maxRequestBytes = optionalInteger(
    options['max-request-bytes'],
    config.requestPolicy.maxRequestBytes,
    65536,
    33554432,
    '--max-request-bytes'
  );
  config.requestPolicy.requestTimeoutMs = optionalInteger(
    options['request-timeout-ms'],
    config.requestPolicy.requestTimeoutMs,
    1000,
    3600000,
    '--request-timeout-ms'
  );
  config.requestPolicy.allowedHosts = publicUrl && optionalBoolean(options['restrict-public-host'], false, '--restrict-public-host')
    ? [new URL(publicUrl).host.toLowerCase()]
    : [];

  updateConfig(file, () => normalizeInstanceConfig(config));
  if (config.auth.mode === 'oauth') ensureOAuthSecrets(file);
  return { file, config };
}

function executableStatus(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return { ok: !result.error && result.status === 0, output: String(result.stdout || result.stderr || result.error?.message || '').trim() };
}

export function doctor(options = {}) {
  const file = configFile(options);
  const config = normalizeInstanceConfig(readConfig(file));
  const workspace = config.workspaces?.find(item => item.id === config.activeWorkspaceId) || config.workspaces?.[0];
  const checks = [
    { key: 'config', ok: true, detail: file },
    { key: 'workspace', ok: !!workspace && !!fs.statSync(workspace.root, { throwIfNoEntry: false })?.isDirectory(), detail: workspace?.root || 'missing' },
    { key: 'authentication', ok: ['none', 'oauth'].includes(config.auth?.mode), detail: config.auth?.mode || 'oauth' },
    { key: 'oauth-secrets', ok: config.auth?.mode !== 'oauth' || (() => { try { readOAuthSecrets(file); return true; } catch { return false; } })(), detail: config.auth?.mode === 'oauth' ? 'required' : 'optional' },
    { key: 'member-auth', ok: true, detail: config.auth?.mode === 'oauth' ? 'oauth-enabled' : 'not-used-in-loopback-only-mode' },
    { key: 'git', ...executableStatus('git') },
    { key: 'node', ok: true, detail: process.version }
  ];
  const provider = config.connection.provider;
  if (provider === 'ngrok') checks.push({ key: 'ngrok', ...executableStatus('ngrok') });
  if (provider.startsWith('cloudflare')) checks.push({ key: 'cloudflared', ...executableStatus('cloudflared') });
  if (provider === 'cloudflare-managed' || provider === 'external') {
    checks.push({ key: 'public-url', ok: /^https:\/\//i.test(config.connection.publicUrl || ''), detail: config.connection.publicUrl || 'missing' });
  }
  if (config.connection.publicUrl) {
    checks.push({ key: 'public-authentication', ok: config.auth?.mode === 'oauth', detail: config.auth?.mode || 'oauth' });
  }
  if (config.requestPolicy.allowedHosts.length) {
    const configuredHost = config.connection.publicUrl ? new URL(config.connection.publicUrl).host.toLowerCase() : '';
    checks.push({
      key: 'allowed-hosts',
      ok: !configuredHost || config.requestPolicy.allowedHosts.includes(configuredHost),
      detail: config.requestPolicy.allowedHosts.join(', ')
    });
  }
  return {
    ok: checks.every(check => check.ok),
    checks,
    connection: { ...config.connection },
    access: {
      ownerOnly: config.team.members.length === 0,
      memberCount: config.team.members.length,
      workspaceLeasesRequired: config.team.requireWorkspaceLeaseForWrites
    },
    execution: {
      embeddedRunnerEnabled: config.jobs.embeddedRunnerEnabled,
      externalRunnerControlEnabled: config.runnerControl?.enabled === true
    }
  };
}

export function mcpUrl(options = {}) {
  const config = normalizeInstanceConfig(readConfig(configFile(options)));
  const origin = normalizeOrigin(options.url || config.connection.publicUrl || `http://127.0.0.1:${config.server?.port || 8787}`);
  return new URL(`${origin}${config.server?.mcpPath || '/mcp'}`).toString();
}

export function memberList(options = {}) {
  const config = normalizeInstanceConfig(readConfig(configFile(options)));
  return config.team.members.map(memberPublic);
}

export function memberCreate(options = {}) {
  const file = configFile(options);
  const workspaceIds = String(options.workspaces || options.workspace || '').split(',').map(value => value.trim()).filter(Boolean);
  let result = null;
  updateConfig(file, current => {
    const config = normalizeInstanceConfig(current);
    const name = String(options.name || '').trim();
    if (!name) throw new Error('--name is required');
    result = createTeamMember(config, { id: options.id, name, role: options.role, workspaceIds, expiresAt: options['expires-at'] || null });
    return config;
  });
  if (readConfig(file).auth?.mode === 'oauth') ensureOAuthSecrets(file);
  return result;
}

export function memberRotate(options = {}) {
  const file = configFile(options);
  const id = String(options.id || '').trim();
  if (!id) throw new Error('--id is required');
  let result = null;
  updateConfig(file, current => {
    const config = normalizeInstanceConfig(current);
    result = rotateTeamMemberLoginCode(config, id);
    return config;
  });
  if (readConfig(file).auth?.mode === 'oauth') ensureOAuthSecrets(file);
  return result;
}

export function memberRevoke(options = {}) {
  const file = configFile(options);
  const id = String(options.id || '').trim();
  if (!id) throw new Error('--id is required');
  let member = null;
  updateConfig(file, current => {
    const config = normalizeInstanceConfig(current);
    member = revokeTeamMember(config, id);
    return config;
  });
  return member;
}

export async function serve(options = {}) {
  const file = configFile(options);
  if (!fs.existsSync(file)) throw new Error(`Config not found: ${file}`);
  process.env.DEVMATE_CONFIG = file;
  process.env.DEVMATE_PUBLIC_HEALTH_DETAILS = options['public-health-details'] === true || options['public-health-details'] === 'true' ? '1' : '0';
  await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'gateway', 'server-entry.mjs')).href);
}
