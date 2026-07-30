#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunnerCredential, normalizeRunnerControlConfig } from '../gateway/runner-access.mjs';
import { createTeamMember, normalizeDeploymentConfig } from '../gateway/team-access.mjs';
import { __test as legacy } from './devmate-cli.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const legacyScript = path.join(scriptDir, 'devmate-cli.mjs');
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
    const next = inline !== undefined
      ? inline
      : rest[index + 1] && !rest[index + 1].startsWith('--')
        ? rest[++index]
        : true;
    options[rawKey] = next;
  }
  return { command, options, positional };
}

function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  return fallback;
}

function csv(value, fallback = []) {
  const values = value == null ? fallback : String(value).split(',');
  return [...new Set(values.map(item => String(item || '').trim()).filter(Boolean))];
}

function configPath(options) {
  return path.resolve(String(
    options.config || process.env.DEVMATE_CONFIG || path.join(process.cwd(), '.devmate-server', 'config.json')
  ));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function writeSecureJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

function presetOptions(options) {
  const preset = String(options.preset || 'team').trim().toLowerCase();
  if (!PRESETS.has(preset)) throw new Error(`Unknown preset: ${preset}`);
  const defaults = {
    personal: { mode: 'personal', provider: 'ngrok', embeddedRunnerEnabled: true, runnerControlEnabled: false },
    team: { mode: 'team', provider: 'ngrok', embeddedRunnerEnabled: true, runnerControlEnabled: false },
    'control-plane': { mode: 'production', provider: 'external', embeddedRunnerEnabled: false, runnerControlEnabled: true },
    runner: { mode: 'personal', provider: 'external', embeddedRunnerEnabled: false, runnerControlEnabled: false }
  }[preset];
  const provider = String(options.provider || defaults.provider);
  const publicUrl = String(options['public-url'] || '').trim();
  if (preset === 'control-plane' && !publicUrl) {
    throw new Error('The control-plane preset requires --public-url https://devmate.example.com');
  }
  return { preset, ...defaults, provider, publicUrl };
}

function inferPreset(config) {
  if ((config.deployment?.mode || 'personal') === 'personal' && config.jobs?.embeddedRunnerEnabled === false) return 'runner';
  if (config.runnerControl?.enabled && config.jobs?.embeddedRunnerEnabled === false) return 'control-plane';
  if ((config.deployment?.mode || 'personal') === 'personal') return 'personal';
  return 'team';
}

function activeWorkspaceIds(config) {
  const writable = (config.workspaces || []).filter(item => !item.reference && item.mode !== 'readonly');
  return writable.map(item => item.id);
}

function bootstrap(options) {
  const preset = presetOptions(options);
  const memberName = String(options['member-name'] || '').trim();
  if (memberName && !['team', 'control-plane'].includes(preset.preset)) {
    throw new Error('--member-name requires the team or control-plane preset');
  }
  if (options['member-role'] && !memberName) {
    throw new Error('--member-role requires --member-name');
  }
  if (options['runner-concurrency'] !== undefined) {
    const concurrency = Number(options['runner-concurrency']);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
      throw new Error('--runner-concurrency must be an integer from 1 to 16');
    }
  }

  const init = legacy.initConfig({
    ...options,
    mode: preset.mode,
    provider: preset.provider,
    'public-url': preset.publicUrl
  });
  const config = normalizeRunnerControlConfig(normalizeDeploymentConfig(init.config));
  config.version = Math.max(11, Number(config.version) || 0);
  config.appVersion = '2.4.0';
  config.jobs ||= {};
  config.jobs.embeddedRunnerEnabled = preset.embeddedRunnerEnabled;
  config.jobs.allowJobGitSave = config.jobs.allowJobGitSave !== false;
  config.runnerControl.enabled = preset.runnerControlEnabled;
  if (preset.preset === 'runner') {
    config.permissions.blockDangerousOperations = true;
    config.permissions.confirmBeforePush = true;
  }

  let member = null;
  if (memberName) {
    member = createTeamMember(config, {
      name: memberName,
      role: String(options['member-role'] || 'developer'),
      workspaceIds: csv(options['member-workspaces'], [config.activeWorkspaceId]),
      expiresAt: options['member-expires-at'] || null
    });
  }

  let runner = null;
  const createDefaultRunner = preset.preset === 'control-plane' && !bool(options['no-runner-credential']);
  const runnerName = String(options['runner-name'] || (createDefaultRunner ? 'Default Runner' : '')).trim();
  if (runnerName) {
    const workspaceIds = csv(options['runner-workspaces'], activeWorkspaceIds(config));
    const capabilities = csv(options['runner-capabilities'], ['core', 'external']);
    runner = createRunnerCredential(config, {
      name: runnerName,
      workspaceIds,
      capabilities,
      maxConcurrent: Number(options['runner-concurrency']) || 1,
      expiresAt: options['runner-expires-at'] || null
    });
    config.runnerControl.enabled = true;
  }

  writeSecureJson(init.file, config);
  const next = [];
  if (preset.preset === 'runner') {
    next.push('Set DEVMATE_RUNNER_TOKEN or DEVMATE_RUNNER_TOKEN_FILE, then run devmate-runner with this config.');
  } else {
    next.push(`Start the Gateway with: devmate serve --config ${init.file}`);
    if (runner) next.push('Move the one-time dmr_ token to the Runner host secret manager.');
    if (member) next.push('Give the one-time dmt_ token only to its intended team member.');
  }
  return {
    ok: true,
    preset: preset.preset,
    config: init.file,
    ownerToken: init.token,
    ownerUrl: legacy.ownerUrl({ config: init.file, url: preset.publicUrl || undefined }),
    member,
    runner,
    next
  };
}

function status(options) {
  const file = configPath(options);
  const config = normalizeRunnerControlConfig(normalizeDeploymentConfig(readJson(file)));
  const preset = inferPreset(config);
  const activeMembers = (config.team.members || []).filter(item =>
    !item.disabled && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())
  );
  const activeRunnerCredentials = (config.runnerControl.credentials || []).filter(item =>
    !item.disabled && item.salt && item.tokenHash && item.workspaceIds?.length &&
    (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())
  );
  const workspaces = config.workspaces || [];
  const warnings = [];
  if (!config.auth?.token && config.auth?.required !== false) warnings.push('Owner token is missing.');
  if (!workspaces.some(item => !item.reference && item.mode !== 'readonly')) warnings.push('No writable workspace is configured.');
  if (config.team.enabled && !activeMembers.length) warnings.push('Team mode has no active member credentials.');
  if (config.runnerControl.enabled && !activeRunnerCredentials.length) warnings.push('External Runner control is enabled but no active scoped Runner credential exists.');
  if (preset !== 'runner' && config.jobs?.embeddedRunnerEnabled === false && !config.runnerControl.enabled) {
    warnings.push('Embedded Runner is disabled and external Runner control is not enabled.');
  }
  return {
    ok: warnings.length === 0,
    config: file,
    preset,
    deployment: {
      mode: config.deployment.mode,
      tunnelProvider: config.deployment.tunnelProvider,
      publicUrl: config.deployment.publicUrl || null
    },
    workspaces: {
      total: workspaces.length,
      writable: workspaces.filter(item => !item.reference && item.mode !== 'readonly').length,
      activeWorkspaceId: config.activeWorkspaceId || null
    },
    team: {
      enabled: config.team.enabled,
      activeMembers: activeMembers.length,
      totalMembers: config.team.members.length,
      workspaceLeasesRequired: config.team.requireWorkspaceLeaseForWrites
    },
    execution: {
      embeddedRunnerEnabled: config.jobs?.embeddedRunnerEnabled !== false,
      externalRunnerControlEnabled: config.runnerControl.enabled,
      activeRunnerCredentials: activeRunnerCredentials.length,
      enabledPlugins: config.plugins?.enabled || []
    },
    warnings
  };
}

function help() {
  return `DevMate command\n\nRecommended:\n  devmate bootstrap --preset personal|team|control-plane|runner --workspace <path> [options]\n  devmate status --config <path>\n\nBootstrap examples:\n  devmate bootstrap --preset team --workspace /srv/project --member-name Alice\n  devmate bootstrap --preset control-plane --workspace /srv/project --public-url https://devmate.example.com\n  devmate bootstrap --preset runner --workspace /srv/project --config /var/lib/devmate-runner/config.json\n\nExisting commands such as init, serve, doctor, owner-url, and member-* remain supported.\n`;
}

async function forwardLegacy(argv) {
  const child = spawn(process.execPath, [legacyScript, ...argv], {
    stdio: 'inherit',
    env: process.env,
    windowsHide: true
  });
  const onSigint = () => {
    try { child.kill('SIGINT'); } catch {}
  };
  const onSigterm = () => {
    try { child.kill('SIGTERM'); } catch {}
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
      resolve();
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const { command, options } = parseArgs(argv);
  try {
    if (command === 'bootstrap') console.log(JSON.stringify(bootstrap(options), null, 2));
    else if (command === 'status') {
      const result = status(options);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } else if (command === 'help' || command === '--help' || command === '-h') console.log(help());
    else await forwardLegacy(argv);
  } catch (error) {
    console.error(`DevMate: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

export const __test = {
  PRESETS,
  activeWorkspaceIds,
  bool,
  bootstrap,
  configPath,
  csv,
  inferPreset,
  parseArgs,
  presetOptions,
  status
};
