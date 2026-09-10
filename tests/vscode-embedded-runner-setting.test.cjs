'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ensureInstanceConfig, readJson, updateConfig } = require('../shared/config-store.cjs');
const {
  alignLocalEmbeddedRunnerSetting,
  setEmbeddedRunnerPreference
} = require('../vscode-host/lifecycle.js');

function fixture() {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-vscode-runner-setting-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-vscode-runner-workspace-'));
  const configFile = path.join(stateDirectory, 'config.json');
  ensureInstanceConfig({ configFile, workspaceRoot, preferredPort: 8787, appVersion: '3.6.7' });
  return { configFile, stateDirectory, workspaceRoot };
}

test('explicit VS Code embedded Runner preference updates only the shared Runner flag', () => {
  const item = fixture();
  try {
    updateConfig(item.configFile, config => {
      config.jobs.allowJobGitSave = false;
      return config;
    });

    setEmbeddedRunnerPreference(item.configFile, true);
    let config = readJson(item.configFile, null);
    assert.equal(config.jobs.embeddedRunnerEnabled, true);
    assert.equal(config.jobs.allowJobGitSave, false);

    setEmbeddedRunnerPreference(item.configFile, false);
    config = readJson(item.configFile, null);
    assert.equal(config.jobs.embeddedRunnerEnabled, false);
    assert.equal(config.jobs.allowJobGitSave, false);
  } finally {
    fs.rmSync(item.stateDirectory, { recursive: true, force: true });
    fs.rmSync(item.workspaceRoot, { recursive: true, force: true });
  }
});

test('VS Code machine setting aligns to established shared embedded Runner state', async () => {
  const settings = { embeddedRunnerEnabled: false };
  const updates = [];
  const vscode = {
    ConfigurationTarget: { Global: true },
    workspace: {
      getConfiguration() {
        return {
          get(name) { return settings[name]; },
          async update(name, value, target) {
            updates.push({ name, value, target });
            settings[name] = value;
          }
        };
      }
    }
  };

  await alignLocalEmbeddedRunnerSetting(vscode, true);
  assert.equal(settings.embeddedRunnerEnabled, true);
  assert.deepEqual(updates, [{ name: 'embeddedRunnerEnabled', value: true, target: true }]);

  await alignLocalEmbeddedRunnerSetting(vscode, true);
  assert.equal(updates.length, 1, 'already aligned setting must not be rewritten');
});

test('embedded Runner setting listener persists preference without restarting the shared runtime', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'vscode-host', 'lifecycle.js'), 'utf8');
  const start = source.indexOf('if (event.affectsConfiguration(EMBEDDED_RUNNER_SETTING)');
  const end = source.indexOf('if (!RELOAD_SETTINGS.some', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /setEmbeddedRunnerPreference/);
  assert.doesNotMatch(block, /executeCommand\('devMate\.start'/);
  assert.match(block, /next Shared Runtime start/);
});
