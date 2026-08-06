#!/usr/bin/env python3
from pathlib import Path
import re
import textwrap

root = Path(__file__).resolve().parents[1]


def read(name):
    return (root / name).read_text(encoding='utf-8')


def write(name, value):
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value.rstrip() + '\n', encoding='utf-8')


# Export the package-derived version from the one shared configuration module.
store = read('shared/config-store.cjs')
needle = 'module.exports = {\n  MAX_CONFIG_BYTES,\n  SUPPORTED_CONFIG_VERSION,'
replacement = 'module.exports = {\n  DEFAULT_VERSION,\n  MAX_CONFIG_BYTES,\n  SUPPORTED_CONFIG_VERSION,'
if needle not in store:
    raise RuntimeError('Could not export the shared package version')
write('shared/config-store.cjs', store.replace(needle, replacement, 1))

# Standalone CLI reads and mutates config only through the locked atomic store.
cli = read('scripts/devmate-cli.mjs')
cli = cli.replace(
    "import { fileURLToPath, pathToFileURL } from 'node:url';",
    "import { fileURLToPath, pathToFileURL } from 'node:url';\nimport configStore from '../shared/config-store.cjs';",
    1
)
cli = cli.replace(
    "const scriptDir = path.dirname(fileURLToPath(import.meta.url));",
    "const { DEFAULT_VERSION, SUPPORTED_CONFIG_VERSION, readJson: readConfigJson, updateConfig } = configStore;\n\nconst scriptDir = path.dirname(fileURLToPath(import.meta.url));",
    1
)
cli, count = re.subn(
    r"function readJson\(file\) \{.*?\n\}\n\nfunction writeSecureJson\(file, value\) \{.*?\n\}",
    textwrap.dedent(
        """
        function readJson(file) {
          return readConfigJson(file, null, { strict: true, supportedVersion: true });
        }

        function writeSecureJson(file, value) {
          return updateConfig(file, () => value);
        }
        """
    ).strip(),
    cli,
    count=1,
    flags=re.S,
)
if count != 1:
    raise RuntimeError('Could not replace standalone CLI config access')
cli = cli.replace('version: 10,', 'version: SUPPORTED_CONFIG_VERSION,', 1)
cli = cli.replace("appVersion: 'standalone',", 'appVersion: DEFAULT_VERSION,', 1)

cli, count = re.subn(
    r"function memberCreate\(options\) \{.*?\n\}\n\nfunction memberRotate",
    textwrap.dedent(
        """
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

        function memberRotate
        """
    ).strip(),
    cli,
    count=1,
    flags=re.S,
)
if count != 1:
    raise RuntimeError('Could not make member creation transactional')

cli, count = re.subn(
    r"function memberRotate\(options\) \{.*?\n\}\n\nfunction memberRevoke",
    textwrap.dedent(
        """
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

        function memberRevoke
        """
    ).strip(),
    cli,
    count=1,
    flags=re.S,
)
if count != 1:
    raise RuntimeError('Could not make member rotation transactional')

cli, count = re.subn(
    r"function memberRevoke\(options\) \{.*?\n\}\n\nasync function serve",
    textwrap.dedent(
        """
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

        async function serve
        """
    ).strip(),
    cli,
    count=1,
    flags=re.S,
)
if count != 1:
    raise RuntimeError('Could not make member revocation transactional')
write('scripts/devmate-cli.mjs', cli)

# The higher-level bootstrap performs its complete mutation under the same lock.
command = read('scripts/devmate-command.mjs')
command = command.replace("import fs from 'node:fs';\n", '', 1)
command = command.replace(
    "import { fileURLToPath } from 'node:url';",
    "import { fileURLToPath } from 'node:url';\nimport configStore from '../shared/config-store.cjs';",
    1
)
command = command.replace(
    "const scriptDir = path.dirname(fileURLToPath(import.meta.url));",
    "const { DEFAULT_VERSION, SUPPORTED_CONFIG_VERSION, readJson: readConfigJson, updateConfig } = configStore;\n\nconst scriptDir = path.dirname(fileURLToPath(import.meta.url));",
    1
)
command, count = re.subn(
    r"function readJson\(file\) \{.*?\n\}\n\nfunction writeSecureJson\(file, value\) \{.*?\n\}",
    textwrap.dedent(
        """
        function readJson(file) {
          return readConfigJson(file, null, { strict: true, supportedVersion: true });
        }
        """
    ).strip(),
    command,
    count=1,
    flags=re.S,
)
if count != 1:
    raise RuntimeError('Could not replace bootstrap config access')

start = command.index('function bootstrap(options) {')
end = command.index('\nfunction status(options) {', start)
bootstrap = textwrap.dedent(
    """
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
      let config = null;
      let member = null;
      let runner = null;
      updateConfig(init.file, current => {
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

        if (memberName) {
          member = createTeamMember(config, {
            name: memberName,
            role: String(options['member-role'] || 'developer'),
            workspaceIds: csv(options['member-workspaces'], [config.activeWorkspaceId]),
            expiresAt: options['member-expires-at'] || null
          });
        }

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
        return config;
      });

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
    """
).strip()
command = command[:start] + bootstrap + command[end:]
write('scripts/devmate-command.mjs', command)

# package.json is the only version source; no synchronizer rewrites CLI source.
sync = read('scripts/sync-version.mjs')
sync, count = re.subn(
    r"^updateText\('scripts/devmate-command\.mjs'.*?\);\n",
    '',
    sync,
    count=1,
    flags=re.M,
)
if count != 1:
    raise RuntimeError('Could not remove duplicate CLI version synchronization')
write('scripts/sync-version.mjs', sync)

write(
    'tests/cli-config-store.test.mjs',
    textwrap.dedent(
        """
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import os from 'node:os';
        import path from 'node:path';
        import test from 'node:test';
        import configStore from '../shared/config-store.cjs';
        import packageJson from '../package.json' with { type: 'json' };
        import { __test as cli } from '../scripts/devmate-cli.mjs';

        test('standalone CLIs use only the shared configuration store', () => {
          for (const relative of ['scripts/devmate-cli.mjs', 'scripts/devmate-command.mjs']) {
            const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', relative), 'utf8');
            assert.match(source, /shared\/config-store\.cjs/);
            assert.doesNotMatch(source, /writeFileSync\([^\n]*config|function writeSecureJson[\s\S]*writeFileSync/);
          }
        });

        test('standalone initialization writes the supported package version atomically', () => {
          const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-cli-store-'));
          const workspace = path.join(directory, 'workspace');
          const config = path.join(directory, 'state', 'config.json');
          fs.mkdirSync(workspace);
          const result = cli.initConfig({ workspace, config, mode: 'personal', provider: 'external' });
          const persisted = configStore.readJson(config, null, { strict: true, supportedVersion: true });
          assert.equal(result.file, config);
          assert.equal(persisted.version, configStore.SUPPORTED_CONFIG_VERSION);
          assert.equal(persisted.appVersion, packageJson.version);
          assert.equal(persisted.auth.token, result.token);
        });
        """
    )
)

(root / 'scripts/finalize_cli_config.py').unlink()
print('Unified standalone CLI configuration persistence.')
