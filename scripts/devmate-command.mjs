#!/usr/bin/env node
import path from 'node:path';
import configStore from '../shared/config-store.cjs';
import { createRunnerCredential, normalizeRunnerControlConfig } from '../gateway/runner-access.mjs';
import { normalizeDeploymentConfig } from '../gateway/team-access.mjs';
import {
  cleanMode,
  cleanProvider,
  configFile,
  doctor,
  initConfig,
  memberCreate,
  memberList,
  memberRevoke,
  memberRotate,
  normalizeOrigin,
  ownerUrl,
  readConfig,
  serve
} from './standalone-runtime.mjs';

const { DEFAULT_VERSION, SUPPORTED_CONFIG_VERSION, updateConfig } = configStore;
const PRESETS = new Set(['personal', 'team', 'control-plane', 'runner']);

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

function presetOptions(options = {}) {
  const preset = String(options.preset || 'team').trim().toLowerCase();
  if (!PRESETS.has(preset)) throw new Error(`Unknown preset: ${preset}`);
  const defaults = {
    personal: { mode: 'personal', provider: 'ngrok', embeddedRunnerEnabled: true, runnerControlEnabled: false },
    team: { mode: 'team', provider: 'ngrok', embeddedRunnerEnabled: true, runnerControlEnabled: false },
    'control-plane': { mode: 'production', provider: 'external', embeddedRunnerEnabled: false, runnerControlEnabled: true },
    runner: { mode: 'personal', provider: 'external', embeddedRunnerEnabled: false, runnerControlEnabled: false }
  }[preset];
  const publicUrl = String(options['public-url'] || '').trim();
  if (preset === 'control-plane' && !publicUrl) throw new Error('The control-plane preset requires --public-url');
  return { preset, ...defaults, provider: String(options.provider || defaults.provider), publicUrl };
}

function inferPreset(config) {
  if ((config.deployment?.mode || 'personal') === 'personal' && config.jobs?.embeddedRunnerEnabled === false) return 'runner';
  if (config.runnerControl?.enabled && config.jobs?.embeddedRunnerEnabled === false) return 'control-plane';
  if ((config.deployment?.mode || 'personal') === 'personal') return 'personal';
  return 'team';
}

function activeWorkspaceIds(config) {
  return (config.workspaces || []).filter(item => !item.reference && item.mode !== 'readonly').map(item => item.id);
}

function bootstrap(options = {}) {
  const preset = presetOptions(options);
  const memberName = String(options['member-name'] || '').trim();
  if (memberName && !['team', 'control-plane'].includes(preset.preset)) throw new Error('--member-name requires team or control-plane');
  if (options['member-role'] && !memberName) throw new Error('--member-role requires --member-name');
  if (options['runner-concurrency'] !== undefined) {
    const value = Number(options['runner-concurrency']);
    if (!Number.isInteger(value) || value < 1 || value > 16) throw new Error('--runner-concurrency must be an integer from 1 to 16');
  }

  const initialized = initConfig({ ...options, mode: preset.mode, provider: preset.provider, 'public-url': preset.publicUrl });
  let config;
  let runner = null;
  updateConfig(initialized.file, current => {
    config = normalizeRunnerControlConfig(normalizeDeploymentConfig(current));
    config.version = Math.max(SUPPORTED_CONFIG_VERSION, Number(config.version) || 0);
    config.appVersion = DEFAULT_VERSION;
    config.jobs ||= {};
    config.jobs.embeddedRunnerEnabled = preset.embeddedRunnerEnabled;
    config.jobs.allowJobGitSave = config.jobs.allowJobGitSave !== false;
    config.runnerControl.enabled = preset.runnerControlEnabled;
    if (preset.preset === 'runner') {
      config.permissions.blockDangerousOperations = true;
      config.permissions.confirmBeforePush = true;
    }
    const createDefaultRunner = preset.preset === 'control-plane' && !bool(options['no-runner-credential']);
    const runnerName = String(options['runner-name'] || (createDefaultRunner ? 'Default Runner' : '')).trim();
    if (runnerName) {
      runner = createRunnerCredential(config, {
        name: runnerName,
        workspaceIds: csv(options['runner-workspaces'], activeWorkspaceIds(config)),
        capabilities: csv(options['runner-capabilities'], ['core', 'external']),
        maxConcurrent: Number(options['runner-concurrency']) || 1,
        expiresAt: options['runner-expires-at'] || null
      });
      config.runnerControl.enabled = true;
    }
    return config;
  });

  const member = memberName ? memberCreate({
    config: initialized.file,
    name: memberName,
    role: String(options['member-role'] || 'developer'),
    workspaces: csv(options['member-workspaces'], [config.activeWorkspaceId]).join(','),
    'expires-at': options['member-expires-at'] || null
  }) : null;

  return {
    ok: true,
    preset: preset.preset,
    config: initialized.file,
    ownerToken: initialized.token,
    ownerUrl: ownerUrl({ config: initialized.file, url: preset.publicUrl || undefined }),
    member,
    runner,
    next: preset.preset === 'runner'
      ? ['Set the Runner credential and start devmate-runner.']
      : [`Start with: devmate serve --config ${initialized.file}`]
  };
}

function status(options = {}) {
  const file = configPath(options);
  const config = normalizeRunnerControlConfig(normalizeDeploymentConfig(readConfig(file)));
  const preset = inferPreset(config);
  const activeMembers = (config.team.members || []).filter(item => !item.disabled && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()));
  const activeRunners = (config.runnerControl.credentials || []).filter(item =>
    !item.disabled && item.salt && item.tokenHash && item.workspaceIds?.length && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())
  );
  const workspaces = config.workspaces || [];
  const warnings = [];
  if (!config.auth?.token && config.auth?.required !== false) warnings.push('Owner token is missing.');
  if (!workspaces.some(item => !item.reference && item.mode !== 'readonly')) warnings.push('No writable workspace is configured.');
  if (config.team.enabled && !activeMembers.length) warnings.push('Team mode has no active member credentials.');
  if (config.runnerControl.enabled && !activeRunners.length) warnings.push('External Runner control has no active credential.');
  if (preset !== 'runner' && config.jobs?.embeddedRunnerEnabled === false && !config.runnerControl.enabled) warnings.push('No execution path is enabled.');
  return {
    ok: warnings.length === 0,
    config: file,
    preset,
    deployment: { mode: config.deployment.mode, tunnelProvider: config.deployment.tunnelProvider, publicUrl: config.deployment.publicUrl || null },
    workspaces: { total: workspaces.length, writable: workspaces.filter(item => !item.reference && item.mode !== 'readonly').length, activeWorkspaceId: config.activeWorkspaceId || null },
    team: { enabled: config.team.enabled, activeMembers: activeMembers.length, totalMembers: config.team.members.length, workspaceLeasesRequired: config.team.requireWorkspaceLeaseForWrites },
    execution: { embeddedRunnerEnabled: config.jobs?.embeddedRunnerEnabled !== false, externalRunnerControlEnabled: config.runnerControl.enabled, activeRunnerCredentials: activeRunners.length, enabledPlugins: config.plugins?.enabled || [] },
    warnings
  };
}

function help() {
  return `DevMate\n\n  devmate bootstrap --preset personal|team|control-plane|runner --workspace <path>\n  devmate status --config <path>\n  devmate init --workspace <path> [--mode personal|team|production]\n  devmate serve --config <path>\n  devmate doctor --config <path>\n  devmate owner-url --config <path>\n  devmate member-list --config <path>\n  devmate member-create --config <path> --name <name>\n  devmate member-rotate --config <path> --id <id>\n  devmate member-revoke --config <path> --id <id>\n`;
}

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'bootstrap') return console.log(JSON.stringify(bootstrap(options), null, 2));
  if (command === 'status') {
    const result = status(options); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1; return;
  }
  if (command === 'init') {
    const result = initConfig(options);
    return console.log(JSON.stringify({ ok: true, config: result.file, ownerToken: result.token, ownerUrl: ownerUrl({ ...options, config: result.file }) }, null, 2));
  }
  if (command === 'serve') return serve(options);
  if (command === 'doctor') {
    const result = doctor(options); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1; return;
  }
  if (command === 'owner-url') return console.log(ownerUrl(options));
  if (command === 'member-list') return console.log(JSON.stringify({ members: memberList(options) }, null, 2));
  if (command === 'member-create') return console.log(JSON.stringify(memberCreate(options), null, 2));
  if (command === 'member-rotate') return console.log(JSON.stringify(memberRotate(options), null, 2));
  if (command === 'member-revoke') return console.log(JSON.stringify({ member: memberRevoke(options) }, null, 2));
  if (command === 'help' || command === '--help' || command === '-h') return console.log(help());
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch(error => { console.error(`DevMate: ${error?.message || error}`); process.exitCode = 1; });
}

export const __test = {
  PRESETS, activeWorkspaceIds, bool, bootstrap, cleanMode, cleanProvider, configPath, csv, doctor,
  inferPreset, initConfig, memberCreate, memberList, memberRevoke, memberRotate, normalizeOrigin,
  ownerUrl, parseArgs, presetOptions, status
};