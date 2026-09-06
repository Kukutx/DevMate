#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-vscode-e2e-workspace-'));
const sharedState = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-vscode-e2e-state-'));
const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-vscode-e2e-user-data-'));
const settingsDirectory = path.join(userDataDirectory, 'User');
fs.mkdirSync(settingsDirectory, { recursive: true });
fs.writeFileSync(path.join(settingsDirectory, 'settings.json'), `${JSON.stringify({
  'devMate.autoStart': false,
  'devMate.sharedStateDirectory': sharedState,
  'devMate.autoCopyUrl': false
}, null, 2)}\n`, 'utf8');

// VS Code Extension Hosts set this for their own Electron child processes. A
// nested @vscode/test-electron launch must start Code.exe as Electron, not Node.
const inheritedElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
delete process.env.ELECTRON_RUN_AS_NODE;

try {
  await runTests({
    version: '1.133.0',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'tests', 'vscode-host-extension-e2e.cjs'),
    launchArgs: [
      `--user-data-dir=${userDataDirectory}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      workspace
    ],
    extensionTestsEnv: {
      DEVMATE_VSCODE_E2E_WORKSPACE: workspace,
      DEVMATE_VSCODE_E2E_STATE: sharedState
    }
  });
} finally {
  if (inheritedElectronRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
  else process.env.ELECTRON_RUN_AS_NODE = inheritedElectronRunAsNode;
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(sharedState, { recursive: true, force: true });
  fs.rmSync(userDataDirectory, { recursive: true, force: true });
}
