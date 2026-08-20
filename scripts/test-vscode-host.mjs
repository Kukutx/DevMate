#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-vscode-e2e-workspace-'));
const sharedState = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-vscode-e2e-state-'));
const settingsDirectory = path.join(workspace, '.vscode');
fs.mkdirSync(settingsDirectory, { recursive: true });
fs.writeFileSync(path.join(settingsDirectory, 'settings.json'), `${JSON.stringify({
  'devMate.autoStart': false,
  'devMate.sharedStateDirectory': sharedState,
  'devMate.autoCopyUrl': false
}, null, 2)}\n`, 'utf8');

try {
  await runTests({
    version: '1.133.0',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'tests', 'vscode-host-extension-e2e.cjs'),
    launchArgs: [
      workspace,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes'
    ],
    extensionTestsEnv: {
      DEVMATE_VSCODE_E2E_WORKSPACE: workspace,
      DEVMATE_VSCODE_E2E_STATE: sharedState
    }
  });
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(sharedState, { recursive: true, force: true });
}
