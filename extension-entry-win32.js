'use strict';

const childProcess = require('child_process');
const legacyEntry = require('./extension-entry');
const { createNgrokCredentialCompatSpawn } = require('./ngrok-launch-compat');
const { SpawnLayer } = require('./vscode-host/spawn-layer.js');

let credentialCompatLayer = null;
let activationAttempted = false;
let activated = false;

function installCredentialCompatLayer() {
  if (credentialCompatLayer?.active) return credentialCompatLayer;
  credentialCompatLayer = new SpawnLayer({
    childProcess,
    name: 'devmate-windows-ngrok-credential-compat',
    wrap: previousSpawn => createNgrokCredentialCompatSpawn(previousSpawn)
  });
  return credentialCompatLayer.install();
}

function restoreCredentialCompatLayer() {
  const layer = credentialCompatLayer;
  credentialCompatLayer = null;
  if (!layer) return { disposed: true, alreadyDisposed: true };
  return layer.dispose();
}

async function activate(context) {
  if (activationAttempted || activated) {
    const error = new Error('DevMate Windows compatibility integration is already active');
    error.code = 'DEVMATE_WINDOWS_LAYER_ALREADY_ACTIVE';
    throw error;
  }
  activationAttempted = true;
  installCredentialCompatLayer();
  try {
    await legacyEntry.activate(context);
    activated = true;
  } catch (error) {
    try { await legacyEntry.deactivate(); } catch {}
    activationAttempted = false;
    activated = false;
    restoreCredentialCompatLayer();
    throw error;
  }
}

async function deactivate() {
  if (!activationAttempted && !activated && !credentialCompatLayer) return;
  try {
    if (activationAttempted) await legacyEntry.deactivate();
  } finally {
    activationAttempted = false;
    activated = false;
    restoreCredentialCompatLayer();
  }
}

module.exports = {
  activate,
  deactivate,
  installCredentialCompatLayer,
  restoreCredentialCompatLayer
};
