'use strict';

const vscode = require('vscode');
const { VscodeHostLifecycle } = require('./vscode-host/lifecycle.js');

let lifecycle = null;

async function activate(context) {
  if (lifecycle) await lifecycle.deactivate();
  lifecycle = new VscodeHostLifecycle({ vscode });
  try {
    await lifecycle.activate(context);
  } catch (error) {
    const current = lifecycle;
    lifecycle = null;
    try { await current.deactivate(); } catch {}
    throw error;
  }
}

async function deactivate() {
  const current = lifecycle;
  lifecycle = null;
  if (current) await current.deactivate();
}

module.exports = {
  activate,
  deactivate
};
