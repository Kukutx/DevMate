#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import configStore from '../shared/config-store.cjs';
import {
  createTeamMember,
  memberPublic,
  normalizeDeploymentConfig,
  revokeTeamMember,
  rotateTeamMemberToken
} from '../gateway/team-access.mjs';

const { DEFAULT_VERSION, SUPPORTED_CONFIG_VERSION, readJson: readConfigJson, updateConfig } = configStore;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  const positional = [];
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const [rawKey, inline] = value.slice(2).split('=', 2);
    const next = inline !== undefined
      ? inline
      : rest[index + 1] && !rest[index + 1].startsWith('--')
        ? rest[++index]
        : true;
    options[rawKey] = next;
  }
  return { command, options, positional };
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function configFile(options) {
  return path.resolve(String(
    options.config ||
    process.env.DEVMATE_CONFIG ||
    path.join(process.cwd(), '.devmate-server', 'config.json')
  ));
}

function readJson(file) {
  return readConfigJson(file, null, { strict: true, supportedVersion: true });
}

function cleanMode(value) {
  return ['personal', 'team', 'production'].includes(value) ? value : 'team';
}

function cleanProvider(value, mode) {
  const allowed = ['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external'];
  const provider = allowed.includes(value)
    ? value
    : mode === 'production'
      ? 'cloudflare-managed'
      : 'ngrok';
  if (mode === 'production' && provider === 'cloudflare-quick') {
    throw new Error('Cloudflare Quick Tunnels are development-only and cannot be used for production mode');
  }
  return provider;
}

function normalizeOrigin(value, { httpsOnly = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(candidate);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    (httpsOnly && url.protocol !== 'https:') ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(httpsOnly
      ? 'public URL must be a clean HTTPS origin'
      : 'public URL must be a clean HTTP(S) origin');
  }
  if (url.pathname && url.pathname !== '/') throw new Error('public URL must not include a path');
  return `${url.protocol}//${url.host}`;
}

function initConfig(options) {
  const file = configFile(options);
  if (fs.existsSync(file) && options.force !== true && options.force !== 'true') {
    throw new Error(`Config already exists: ${file}. Pass --force to replace it.`);
  }
  const workspace = path.resolve(String(options.workspace || process.cwd()));
  if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${workspace}`);
  }
  const mode = cleanMode(String(options.mode || 'team'));
  const provider = cleanProvider(String(options.provider || ''), mode);
  const port = Math.min(65535, Math.max(1024, Number(options.port) || 8787));
  const token = randomToken();
  const publicUrl = normalizeOrigin(options['public-url'] || '', {
    httpsOnly: mode === 'production'
  });
  const config = {
    version: SUPPORTED_CONFIG_VERSION,
    appVersion: DEFAULT_VERSION,
    instanceId: `standalone-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    server: { port, mcpPath: '/mcp' },
    runtime: {
      defaultCommandTimeoutMs: 180000,
      maxOutputChars: 120000,
      maxPersistentProcesses: 16,
      persistentProcessOutputBytes: 2097152
    },
    maintenance: {
      backupRetentionDays: 30,
      auditRetentionDays: mode === 'production' ? 90 : 30,
      maxBackupBytes: 1073741824,
      maxAuditBytes: 20971520
    },
    connection: {},
    auth: { required: true, token },
    permissions: {
      profile: 'fullAccess',
      readOnly: false,
      blockDangerousOperations: mode !== 'personal',
      confirmBeforePush: mode !== 'personal',
      allowDirectoryMutations: false
    },
    deployment: { mode, tunnelProvider: provider, publicUrl },
    team: {
      enabled: mode !== 'personal',
      members: [],
      requireWorkspaceLeaseForWrites: mode !== 'personal',
      defaultMemberRole: 'developer',
      maxMembers: 100
    },
    production: {
      maxRequestBytes: 2097152,
      requestsPerMinute: mode === 'production' ? 120 : 600,
      maxConcurrentRequests: mode === 'production' ? 24 : 64,
      maxConcurrentPerPrincipal: mode === 'production' ? 4 : 16,
      requestTimeoutMs: 900000,
      allowedHosts: publicUrl ? [new URL(publicUrl).host.toLowerCase()] : []
    },
    vscodeContext: {
      capturedAt: null,
      activeEditor: null,
      visibleEditors: [],
      diagnostics: []
    },
    activeWorkspaceId: 'workspace',
    workspaces: [{
      id: 'workspace',
      name: path.basename(workspace),
      root: workspace,
      mode: 'workspace-write',
      reference: false,
      role: 'active'
    }],
    commands: [],
    plugins: { enabled: [], settings: {} },
    trustedWritableRoots: []
  };
  updateConfig(file, () => config);
  return { file, config, token };
}

function executableStatus(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000
  });
  return {
    ok: !result.error && result.status === 0,
    output: String(result.stdout || result.stderr || result.error?.message || '').trim()
  };
}

function doctor(options) {
  const file = configFile(options);
  const config = normalizeDeploymentConfig(readJson(file));
  const workspace = config.workspaces?.find(item => item.id === config.activeWorkspaceId) ||
    config.workspaces?.[0];
  const checks = [
    { key: 'config', ok: true, detail: file },
    {
      key: 'workspace',
      ok: !!workspace && !!fs.statSync(workspace.root, { throwIfNoEntry: false })?.isDirectory(),
      detail: workspace?.root || 'missing'
    },
    {
      key: 'owner-token',
      ok: !!config.auth?.token,
      detail: config.auth?.token ? 'configured' : 'missing'
    },
    { key: 'git', ...executableStatus('git') },
    { key: 'node', ok: true, detail: process.version }
  ];
  const provider = config.deployment?.tunnelProvider;
  if (provider === 'ngrok') {
    const status = executableStatus('ngrok');
    checks.push({ key: 'ngrok', ok: status.ok, detail: status.output });
  }
  if (String(provider).startsWith('cloudflare')) {
    const status = executableStatus('cloudflared');
    checks.push({ key: 'cloudflared', ok: status.ok, detail: status.output });
  }
  if (config.deployment?.mode === 'production') {
    checks.push({
      key: 'public-url',
      ok: /^https:\/\//i.test(config.deployment.publicUrl || ''),
      detail: config.deployment.publicUrl || 'missing'
    });
    checks.push({
      key: 'allowed-hosts',
      ok: !!config.production?.allowedHosts?.length,
      detail: (config.production?.allowedHosts || []).join(', ') || 'missing'
    });
  }
  return {
    ok: checks.every(check => check.ok),
    checks,
    deployment: config.deployment,
    teamEnabled: !!config.team?.enabled
  };
}

function ownerUrl(options) {
  const config = readJson(configFile(options));
  const origin = normalizeOrigin(
    options.url ||
    config.deployment?.publicUrl ||
    `http://127.0.0.1:${config.server?.port || 8787}`
  );
  return new URL(`${origin}${config.server?.mcpPath || '/mcp'}`).toString();
}

function memberList(options) {
  const config = normalizeDeploymentConfig(readJson(configFile(options)));
  return config.team.members.map(memberPublic);
}

function memberCreate(options) {
  const file = configFile(options);
  const workspaceIds = String(options.workspaces || options.workspace || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  let result = null;
  updateConfig(file, current => {
    const config = normalizeDeploymentConfig(current);
    if (!config.team.enabled) throw new Error('Team mode is not enabled in this config');
    result = createTeamMember(config, {
      id: options.id,
      name: String(options.name || '').trim(),
      role: options.role,
      workspaceIds,
      expiresAt: options['expires-at'] || null
    });
    if (!result.member.name) throw new Error('--name is required');
    return config;
  });
  return result;
}

function memberRotate(options) {
  const file = configFile(options);
  const id = String(options.id || '').trim();
  if (!id) throw new Error('--id is required');
  let result = null;
  updateConfig(file, current => {
    const config = normalizeDeploymentConfig(current);
    result = rotateTeamMemberToken(config, id);
    return config;
  });
  return result;
}

function memberRevoke(options) {
  const file = configFile(options);
  const id = String(options.id || '').trim();
  if (!id) throw new Error('--id is required');
  let member = null;
  updateConfig(file, current => {
    const config = normalizeDeploymentConfig(current);
    member = revokeTeamMember(config, id);
    return config;
  });
  return member;
}

async function serve(options) {
  const file = configFile(options);
  if (!fs.existsSync(file)) throw new Error(`Config not found: ${file}`);
  process.env.DEVMATE_CONFIG = file;
  process.env.DEVMATE_PUBLIC_HEALTH_DETAILS =
    options['public-health-details'] === true ||
    options['public-health-details'] === 'true'
      ? '1'
      : '0';
  await import(pathToFileURL(path.join(rootDir, 'gateway', 'server-entry.mjs')).href);
}

function help() {
  return `DevMate standalone gateway\n\nCommands:\n  devmate init --workspace <path> [--config <path>] [--mode personal|team|production] [--provider ngrok|cloudflare-managed|external]\n  devmate serve --config <path>\n  devmate doctor --config <path>\n  devmate owner-url --config <path> [--url https://devmate.example.com]  # send ownerToken as Authorization: Bearer\n  devmate member-list --config <path>\n  devmate member-create --config <path> --name <name> [--role developer] [--workspaces workspace]\n  devmate member-rotate --config <path> --id <member-id>\n  devmate member-revoke --config <path> --id <member-id>\n\nSecrets for production tunnels remain outside config.json. Run ngrok/cloudflared as a separate managed service or use the VS Code deployment integration.\n`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { command, options } = parseArgs(process.argv.slice(2));
  try {
    if (command === 'init') {
      const result = initConfig(options);
      console.log(JSON.stringify({
        ok: true,
        config: result.file,
        ownerToken: result.token,
        ownerUrl: ownerUrl({ ...options, config: result.file })
      }, null, 2));
    } else if (command === 'serve') {
      await serve(options);
    } else if (command === 'doctor') {
      const result = doctor(options);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } else if (command === 'owner-url') {
      console.log(ownerUrl(options));
    } else if (command === 'member-list') {
      console.log(JSON.stringify({ members: memberList(options) }, null, 2));
    } else if (command === 'member-create') {
      console.log(JSON.stringify(memberCreate(options), null, 2));
    } else if (command === 'member-rotate') {
      console.log(JSON.stringify(memberRotate(options), null, 2));
    } else if (command === 'member-revoke') {
      console.log(JSON.stringify({ member: memberRevoke(options) }, null, 2));
    } else {
      console.log(help());
    }
  } catch (error) {
    console.error(`DevMate: ${error.message || error}`);
    process.exitCode = 1;
  }
}

export const __test = {
  cleanMode,
  cleanProvider,
  initConfig,
  memberCreate,
  memberList,
  normalizeOrigin,
  ownerUrl,
  parseArgs
};
