'use strict';

const ATTACHMENT_POLL_MS = 1000;

let controller = null;
let attachmentTimer = null;
let attachmentPort = 0;
let recoveringAttachment = false;

function stopAttachmentWatcher() {
  if (attachmentTimer) clearInterval(attachmentTimer);
  attachmentTimer = null;
  attachmentPort = 0;
  recoveringAttachment = false;
}

function startAttachmentWatcher(port) {
  stopAttachmentWatcher();
  attachmentPort = Number(port) || 0;
  if (!attachmentPort || !controller) return;
  attachmentTimer = setInterval(() => {
    const current = controller;
    if (!current || recoveringAttachment) return;
    let status;
    try {
      status = current.status(attachmentPort);
    } catch (error) {
      current.logger?.(`Tunnel attachment watch failed: ${error.message || error}`);
      return;
    }
    if (status.owned) {
      stopAttachmentWatcher();
      return;
    }
    if (status.running) return;
    recoveringAttachment = true;
    Promise.resolve(current.start(attachmentPort))
      .then(result => {
        if (controller === current && result?.owned) stopAttachmentWatcher();
      })
      .catch(error => current.logger?.(`Tunnel follower recovery failed: ${error.message || error}`))
      .finally(() => { recoveringAttachment = false; });
  }, ATTACHMENT_POLL_MS);
  attachmentTimer.unref?.();
}

function setTunnelController(value) {
  if (!value || typeof value.start !== 'function' || typeof value.stop !== 'function' || typeof value.status !== 'function') {
    throw new TypeError('A TunnelController-compatible runtime is required');
  }
  if (controller !== value) stopAttachmentWatcher();
  controller = value;
  return controller;
}

function clearTunnelController(value = null) {
  if (value && controller !== value) return false;
  stopAttachmentWatcher();
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
  const result = await tunnelController().start(port);
  if (result?.attached) startAttachmentWatcher(port);
  else stopAttachmentWatcher();
  return result;
}

async function stopTunnel() {
  stopAttachmentWatcher();
  return tunnelController().stop();
}

function tunnelStatus(port) {
  return tunnelController().status(port);
}

module.exports = {
  ATTACHMENT_POLL_MS,
  clearTunnelController,
  setTunnelController,
  startTunnel,
  stopAttachmentWatcher,
  stopTunnel,
  tunnelController,
  tunnelStatus
};
