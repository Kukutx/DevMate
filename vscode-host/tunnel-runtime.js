'use strict';

let controller = null;

function setTunnelController(value) {
  if (!value || typeof value.start !== 'function' || typeof value.stop !== 'function' || typeof value.status !== 'function') {
    throw new TypeError('A TunnelController-compatible runtime is required');
  }
  controller = value;
  return controller;
}

function clearTunnelController(value = null) {
  if (value && controller !== value) return false;
  controller = null;
  return true;
}

function tunnelController() {
  if (!controller) {
    const error = new Error('DevMate tunnel runtime is not initialized');
    error.code = 'DEVMATE_TUNNEL_RUNTIME_UNAVAILABLE';
    throw error;
  }
  return controller;
}

async function startTunnel(port) {
  return tunnelController().start(port);
}

async function stopTunnel() {
  return tunnelController().stop();
}

function tunnelStatus(port) {
  return tunnelController().status(port);
}

module.exports = {
  clearTunnelController,
  setTunnelController,
  startTunnel,
  stopTunnel,
  tunnelController,
  tunnelStatus
};
