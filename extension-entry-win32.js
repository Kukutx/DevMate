'use strict';

const childProcess = require('child_process');
const legacyEntry = require('./extension-entry');
const { createNgrokCredentialCompatSpawn } = require('./ngrok-launch-compat');

async function activate(context) {
  const previousSpawn = childProcess.spawn;
  childProcess.spawn = createNgrokCredentialCompatSpawn(previousSpawn);
  try {
    await legacyEntry.activate(context);
  } finally {
    childProcess.spawn = previousSpawn;
  }
}

async function deactivate() {
  if (legacyEntry?.deactivate) await legacyEntry.deactivate();
}

module.exports = { activate, deactivate };
