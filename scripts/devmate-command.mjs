#!/usr/bin/env node
import path from 'node:path';
import configStore from '../shared/config-store.cjs';
import { createRunnerCredential, normalizeRunnerControlConfig } from '../gateway/runner-access.mjs';
import { normalizeInstanceConfig } from '../gateway/team-access.mjs';
import {
  configFile,
  doctor,
  initConfig,
  memberCreate,
  memberList,
  memberRevoke,
  memberRotate,
  mcpUrl,
  readConfig,
  serve
} from './standalone-runtime.mjs';

const { DEFAULT_VERSION, updateConfig } = configStore;

const BOOTSTRAP_PRESETS = Object.freeze({
  personal: Object.freeze({
    'authentication-mode': 'none',
    'embedded-runner': true,
    'external-runner-control': false,
    'require-workspace-lease-for-writes': false
  }),
  team: Object.freeze({
    'authentication-mode': 'none',
    'embedded-runner': true,
    'external-runner-control': false,
    'require-workspace-lease-for-writes': true
  }),
  'control-plane': Object.freeze({
    provider: 'external',
    'authentication-mode': 'none',
    'embedded-runner': false,
    'external-runner-control': true,
    'require-workspace-lease-for-writes': true,
    'restrict-public-host': true
  }),
  runner: Object.freeze({
    'authentication-mode': 'none',
    'embedded-runner': false,
    'external-runner-control': false,
    'require-workspace-lease-for-writes': false
  })
});

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const [rawKey, inline] = value.slice(2).split('=', 2);
    options[rawKey] = inline !== undefined
      ? inline
      : rest[index + 1] && !rest[index + 1].startsWith('--')
        ? rest[++index]
        : true;
  }
  return { command, options, positional };
}

function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  throw new Error(`Expected boolean value, received: ${value}`);
}

function csv(value, fallback = []) {
  const values = value == null ? fallback : String(value).split(',');
  return [...new Set(values.map(item => String(item || '').trim()).filter(Boolean))];
}

function configPath(options = {}) { return configFile(options); }

function activeWorkspaceIds(config) {
  return (config.workspaces || [])
    .filter(item => !item.reference && item.mode !== 'readonly')
    .map(item => item.id);
}

function bootstrapPreset(value) {
  const preset = String(value || '').trim().toLowerCase();
  if (!preset || !Object.hasOwn(BOOTSTRAP_PRESETS, preset)) {
    throw new Error(`Unknown bootstrap preset: ${String(value)}`);
  }
  return preset;
}

function presetOptions(options = {}) {
  if (options.preset === undefined) return { preset: '', options: { ...options } };
  const preset = bootstrapPreset(options.preset);
  return {
    preset,
    options: { ...BOOTSTRAP_PRESETS[preset], ...options, preset }
  };
}

function bootstrap(options = {}) {
  const resolved = presetOptions(options);
  const effective = { ...resolved.options };
  const memberName = String(effective['member-name'] || '').trim();
  if (effective['member-role'] && !memberName) throw new Error('--member-role requires --member-name');
  if (effective['runner-concurrency'] !== undefined) {
    const value = Number(effective['runner-concurrency']);
    if (!Number.isInteger(value) || value < 1 || value > 16) throw new Error('--runner-concurrency must be an integer from 1 to 16');
  }

  const initialized = initConfig(effective);
  let config;
  let runner = null;
  updateConfig(initialized.file, current => {
    config = normalizeRunnerControlConfig(normalizeInstanceConfig(current));
    config.appVersion = DEFAULT_VERSION;

    if (effective['embedded-runner'] !== undefined) {
      config.jobs.embeddedRunnerEnabled = bool(effective['embedded-runner'], true);
    }
    if (effective['external-runner-control'] !== undefined) {
      config.runnerControl.enabled = bool(effective['external-runner-control']);
    }

    const runnerName = String(effective['runner-name'] || '').trim();
    if (runnerName) {
      runner = createRunnerCredential(config, {
        name: runnerName,
        workspaceIds: csv(effective['runner-workspaces'], activeWorkspaceIds(config)),
        capabilities: csv(effective['runner-capabilities'], ['core', 'external']),
        maxConcurrent: Number(effective['runner-concurrency']) || 1,
        expiresAt: effective['runner-expires-at'] || null
      });
      config.runnerControl.enabled = true;
    }
    return config;
  });

  const member = memberName ? memberCreate({
    config: initialized.file,
    name: memberName,
    role: String(effective['member-role'] || 'developer'),
    workspaces: csv(effective['member-workspaces'], [config.activeWorkspaceId]).join(','),
    'expires-at': effective['member-expires-at'] || null
  }) : null;

  const finalConfig = normalizeRunnerControlConfig(normalizeInstanceConfig(readConfig(initialized.file)));
  return {
    ok: true,
    ...(resolved.preset ? { preset: resolved.preset } : {}),
    config: initialized.file,
    authenticationMode: finalConfig.auth?.mode || 'none',
    mcpUrl: mcpUrl({ config: initialized.file, url: finalConfig.connection.publicUrl || undefined }),
    connection: { ...finalConfig.connection },
    access: {
      ownerOnly: finalConfig.team.members.length === 0,
      memberCount: finalConfig.team.members.length,
      workspaceLeasesRequired: finalConfig.team.requireWorkspaceLeaseForWrites
    },
    execution: {
      embeddedRunnerEnabled: finalConfig.jobs.embeddedRunnerEnabled,
      externalRunnerControlEnabled: finalConfig.runnerControl.enabled
    },
    member,
    runner,
    next: [`Start with: devmate serve --config ${initialized.file}`]
  };
}

function status(options = {}) {
  const file = configPath(options);
  const config = normalizeRunnerControlConfig(normalizeInstanceConfig(readConfig(file)));
  const activeMembers = config.team.members.filter(item =>
    !item.disabled && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())
  );
  const activeRunners = config.runnerControl.credentials.filter(item =>
    !item.disabled && item.salt && item.tokenHash && item.workspaceIds?.length && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())
  );
  const workspaces = config.workspaces || [];
  const warnings = [];
  if (!['none', 'oauth'].includes(config.auth?.mode)) warnings.push('Authentication mode is invalid.');
  if (!workspaces.some(item => !item.reference && item.mode !== 'readonly')) warnings.push('No writable workspace is configured.');
  if (config.runnerControl.enabled && !activeRunners.length) warnings.push('External Runner control is enabled but has no active credential.');
  if (
    (config.connection.provider === 'cloudflare-managed' || config.connection.provider === 'external') &&
    !config.connection.publicUrl
  ) warnings.push(`${config.connection.provider} requires a public HTTPS URL.`);

  return {
    ok: warnings.length === 0,
    config: file,
    connection: { ...config.connection },
    workspaces: {
      total: workspaces.length,
      writable: workspaces.filter(item => !item.reference && item.mode !== 'readonly').length,
      activeWorkspaceId: config.activeWorkspaceId || null
    },
    access: {
      ownerOnly: config.team.members.length === 0,
      activeMembers: activeMembers.length,
      totalMembers: config.team.members.length,
      workspaceLeasesRequired: config.team.requireWorkspaceLeaseForWrites
    },
    execution: {
      embeddedRunnerEnabled: config.jobs.embeddedRunnerEnabled,
      externalRunnerControlEnabled: config.runnerControl.enabled,
      activeRunnerCredentials: activeRunners.length,
      enabledPlugins: config.plugins?.enabled || []
    },
    requestPolicy: { ...config.requestPolicy },
    warnings
  };
}

function help() {
  return `DevMate\n\n  devmate bootstrap --preset personal|team|control-plane|runner --workspace <path> [capability options]\n  devmate bootstrap --workspace <path> [--provider ngrok|cloudflare-quick|cloudflare-managed|external] [--public-url <https-origin>] [--authentication-mode none|oauth]\n  devmate bootstrap --workspace <path> [--member-name <name>] [--runner-name <name>]\n  devmate status --config <path>\n  devmate init --workspace <path> [--provider <provider>] [--public-url <https-origin>] [--authentication-mode none|oauth]\n  devmate serve --config <path>\n  devmate doctor --config <path>\n  devmate mcp-url --config <path>\n  devmate member-list --config <path>\n  devmate member-create --config <path> --name <name> --workspaces <id,...>\n  devmate member-rotate --config <path> --id <id>\n  devmate member-revoke --config <path> --id <id>\n\nAll bootstrap presets default to no-auth, including public MCP. OAuth remains available only when explicitly selected with --authentication-mode oauth.\n`;
}

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'bootstrap') return console.log(JSON.stringify(bootstrap(options), null, 2));
  if (command === 'status') {
    const result = status(options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'init') {
    const result = initConfig(options);
    return console.log(JSON.stringify({
      ok: true,
      config: result.file,
      authenticationMode: result.config.auth?.mode || 'none',
      mcpUrl: mcpUrl({ ...options, config: result.file })
    }, null, 2));
  }
  if (command === 'serve') return serve(options);
  if (command === 'doctor') {
    const result = doctor(options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'mcp-url') return console.log(mcpUrl(options));
  if (command === 'member-list') return console.log(JSON.stringify({ members: memberList(options) }, null, 2));
  if (command === 'member-create') return console.log(JSON.stringify(memberCreate(options), null, 2));
  if (command === 'member-rotate') return console.log(JSON.stringify(memberRotate(options), null, 2));
  if (command === 'member-revoke') return console.log(JSON.stringify({ member: memberRevoke(options) }, null, 2));
  if (command === 'help' || command === '--help' || command === '-h') return console.log(help());
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch(error => {
    console.error(`DevMate: ${error?.message || error}`);
    process.exitCode = 1;
  });
}

export const __test = {
  BOOTSTRAP_PRESETS,
  activeWorkspaceIds,
  bool,
  bootstrap,
  bootstrapPreset,
  configPath,
  csv,
  doctor,
  initConfig,
  memberCreate,
  memberList,
  memberRevoke,
  memberRotate,
  mcpUrl,
  parseArgs,
  presetOptions,
  status
};
