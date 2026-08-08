import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import configStore from '../shared/config-store.cjs';
import portConfig from '../shared/port.cjs';
import {
  createTeamMember,
  memberPublic,
  normalizeDeploymentConfig,
  revokeTeamMember,
  rotateTeamMemberToken
} from '../gateway/team-access.mjs';

const { DEFAULT_VERSION, newPersonalConfig, readJson: readConfigJson, updateConfig } = configStore;
const { parsePortOption } = portConfig;

export function configFile(options = {}) {
  return path.resolve(String(options.config || process.env.DEVMATE_CONFIG || path.join(process.cwd(), '.devmate-server', 'config.json')));
}

export function readConfig(file) {
  return readConfigJson(file, null, { strict: true, supportedVersion: true });
}

export function cleanMode(value) {
  if (!['personal', 'team', 'production'].includes(value)) throw new Error(`Unknown deployment mode: ${value}`);
  return value;
}

export function cleanProvider(value, mode) {
  const allowed = ['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external'];
  if (!allowed.includes(value)) throw new Error(`Unknown tunnel provider: ${value}`);
  if (mode === 'production' && value === 'cloudflare-quick') throw new Error('Cloudflare Quick Tunnels are development-only and cannot be used for production mode');
  return value;
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

export function validateStandaloneIngress({ mode, provider, publicUrl }) {
  if (mode === 'production' && provider === 'cloudflare-quick') {
    throw new Error('Cloudflare Quick Tunnels are development-only and cannot be used for production mode');
  }
  if (mode === 'production' && !publicUrl) {
    throw new Error('Production mode requires --public-url with a stable HTTPS origin');
  }
  return { mode, provider, publicUrl };
}

export function initConfig(options = {}) {
  const file = configFile(options);
  if (fs.existsSync(file) && options.force !== true && options.force !== 'true') throw new Error(`Config already exists: ${file}. Pass --force to replace it.`);
  const workspace = path.resolve(String(options.workspace || process.cwd()));
  if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Workspace is not a directory: ${workspace}`);

  const mode = cleanMode(String(options.mode || 'team'));
  const provider = cleanProvider(String(options.provider || (mode === 'production' ? 'cloudflare-managed' : 'ngrok')), mode);
  const port = parsePortOption(options.port, { label: '--port' });
  const rawPublicUrl = String(options['public-url'] || '').trim();
  const publicUrl = normalizeOrigin(rawPublicUrl, { httpsOnly: mode === 'production' || !!rawPublicUrl });
  validateStandaloneIngress({ mode, provider, publicUrl });
  const config = newPersonalConfig({ workspaceRoot: workspace, port, appVersion: DEFAULT_VERSION });

  config.instanceId = `standalone-${Date.now().toString(36)}`;
  config.activeWorkspaceId = 'workspace';
  config.workspaces[0].id = 'workspace';
  config.deployment = { mode, tunnelProvider: provider, publicUrl };
  config.team.enabled = mode !== 'personal';
  config.team.requireWorkspaceLeaseForWrites = mode !== 'personal';
  config.permissions.blockDangerousOperations = mode !== 'personal';
  config.permissions.confirmBeforePush = mode !== 'personal';
  config.maintenance.auditRetentionDays = mode === 'production' ? 90 : 30;
  config.production.requestsPerMinute = mode === 'production' ? 120 : 600;
  config.production.maxConcurrentRequests = mode === 'production' ? 24 : 64;
  config.production.maxConcurrentPerPrincipal = mode === 'production' ? 4 : 16;
  config.production.allowedHosts = publicUrl ? [new URL(publicUrl).host.toLowerCase()] : [];

  updateConfig(file, () => config);
  return { file, config, token: config.auth.token };
}

function executableStatus(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return { ok: !result.error && result.status === 0, output: String(result.stdout || result.stderr || result.error?.message || '').trim() };
}

export function doctor(options = {}) {
  const file = configFile(options);
  const config = normalizeDeploymentConfig(readConfig(file));
  const workspace = config.workspaces?.find(item => item.id === config.activeWorkspaceId) || config.workspaces?.[0];
  const checks = [
    { key: 'config', ok: true, detail: file },
    { key: 'workspace', ok: !!workspace && !!fs.statSync(workspace.root, { throwIfNoEntry: false })?.isDirectory(), detail: workspace?.root || 'missing' },
    { key: 'owner-token', ok: !!config.auth?.token, detail: config.auth?.token ? 'configured' : 'missing' },
    { key: 'git', ...executableStatus('git') },
    { key: 'node', ok: true, detail: process.version }
  ];
  const provider = config.deployment?.tunnelProvider;
  if (provider === 'ngrok') checks.push({ key: 'ngrok', ...executableStatus('ngrok') });
  if (String(provider).startsWith('cloudflare')) checks.push({ key: 'cloudflared', ...executableStatus('cloudflared') });
  if (config.deployment?.mode === 'production') {
    checks.push({ key: 'public-url', ok: /^https:\/\//i.test(config.deployment.publicUrl || ''), detail: config.deployment.publicUrl || 'missing' });
    checks.push({ key: 'allowed-hosts', ok: !!config.production?.allowedHosts?.length, detail: (config.production?.allowedHosts || []).join(', ') || 'missing' });
  }
  return { ok: checks.every(check => check.ok), checks, deployment: config.deployment, teamEnabled: !!config.team?.enabled };
}

export function ownerUrl(options = {}) {
  const config = readConfig(configFile(options));
  const origin = normalizeOrigin(options.url || config.deployment?.publicUrl || `http://127.0.0.1:${config.server?.port || 8787}`);
  return new URL(`${origin}${config.server?.mcpPath || '/mcp'}`).toString();
}

export function memberList(options = {}) {
  const config = normalizeDeploymentConfig(readConfig(configFile(options)));
  return config.team.members.map(memberPublic);
}

export function memberCreate(options = {}) {
  const file = configFile(options);
  const workspaceIds = String(options.workspaces || options.workspace || '').split(',').map(value => value.trim()).filter(Boolean);
  let result = null;
  updateConfig(file, current => {
    const config = normalizeDeploymentConfig(current);
    if (!config.team.enabled) throw new Error('Team mode is not enabled in this config');
    const name = String(options.name || '').trim();
    if (!name) throw new Error('--name is required');
    result = createTeamMember(config, { id: options.id, name, role: options.role, workspaceIds, expiresAt: options['expires-at'] || null });
    return config;
  });
  return result;
}

export function memberRotate(options = {}) {
  const file = configFile(options);
  const id = String(options.id || '').trim();
  if (!id) throw new Error('--id is required');
  let result = null;
  updateConfig(file, current => { const config = normalizeDeploymentConfig(current); result = rotateTeamMemberToken(config, id); return config; });
  return result;
}

export function memberRevoke(options = {}) {
  const file = configFile(options);
  const id = String(options.id || '').trim();
  if (!id) throw new Error('--id is required');
  let member = null;
  updateConfig(file, current => { const config = normalizeDeploymentConfig(current); member = revokeTeamMember(config, id); return config; });
  return member;
}

export async function serve(options = {}) {
  const file = configFile(options);
  if (!fs.existsSync(file)) throw new Error(`Config not found: ${file}`);
  process.env.DEVMATE_CONFIG = file;
  process.env.DEVMATE_PUBLIC_HEALTH_DETAILS = options['public-health-details'] === true || options['public-health-details'] === 'true' ? '1' : '0';
  await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'gateway', 'server-entry.mjs')).href);
}
