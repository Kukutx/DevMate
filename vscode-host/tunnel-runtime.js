'use strict';

const ATTACHMENT_POLL_MS = 1000;
// Retained as an exported compatibility surface. ERR_NGROK_334 reconciliation belongs
// entirely to TunnelController; the runtime must not add blind retry/backoff latency
// after that bounded recovery path has already completed.
const NGROK_CONFLICT_RETRY_DELAYS_MS = Object.freeze([]);

let controller = null;
let attachmentTimer = null;
let attachmentPort = 0;
let attachmentRecoveryPromise = null;
let startOperation = null;
let sessionRequested = false;

function stopAttachmentWatcher() {
  if (attachmentTimer) clearInterval(attachmentTimer);
  attachmentTimer = null;
  attachmentPort = 0;
}

function recoverAttachment(current, port) {
  if (attachmentRecoveryPromise) return attachmentRecoveryPromise;
  let recovery;
  recovery = Promise.resolve()
    .then(() => current.start(port))
    .then(result => {
      if (controller === current && sessionRequested && result?.owned) stopAttachmentWatcher();
      return result;
    })
    .catch(error => {
      current.logger?.(`Tunnel follower recovery failed: ${error.message || error}`);
      return null;
    })
    .finally(() => {
      if (attachmentRecoveryPromise === recovery) attachmentRecoveryPromise = null;
    });
  attachmentRecoveryPromise = recovery;
  return recovery;
}

function startAttachmentWatcher(port) {
  stopAttachmentWatcher();
  attachmentPort = Number(port) || 0;
  if (!attachmentPort || !controller) return;
  attachmentTimer = setInterval(() => {
    const current = controller;
    if (!current || attachmentRecoveryPromise || !sessionRequested) return;
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
    void recoverAttachment(current, attachmentPort);
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
  sessionRequested = false;
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

async function startTunnelAttempt(current, port) {
  return current.start(port);
}

async function startTunnel(port) {
  const current = tunnelController();
  const requestedPort = Number(port) || 0;
  if (startOperation) {
    if (startOperation.controller === current && startOperation.port === requestedPort) {
      return startOperation.promise;
    }
    await startOperation.promise.catch(() => null);
  }

  let operation;
  operation = (async () => {
    try {
      const result = await startTunnelAttempt(current, requestedPort);
      sessionRequested = true;
      if (result?.attached) startAttachmentWatcher(requestedPort);
      else stopAttachmentWatcher();
      return result;
    } catch (error) {
      sessionRequested = false;
      stopAttachmentWatcher();
      throw error;
    }
  })();
  startOperation = { controller: current, port: requestedPort, promise: operation };
  try {
    return await operation;
  } finally {
    if (startOperation?.promise === operation) startOperation = null;
  }
}

async function stopTunnel() {
  const current = tunnelController();
  sessionRequested = false;
  stopAttachmentWatcher();
  const pendingStart = startOperation?.controller === current ? startOperation.promise : null;
  if (pendingStart) await pendingStart.catch(() => null);
  const pendingRecovery = attachmentRecoveryPromise;
  if (pendingRecovery) await pendingRecovery.catch(() => null);
  return current.stop();
}

function tunnelStatus(port) {
  return tunnelController().status(port);
}

function tunnelSessionRequested() {
  return sessionRequested;
}

module.exports = {
  ATTACHMENT_POLL_MS,
  NGROK_CONFLICT_RETRY_DELAYS_MS,
  clearTunnelController,
  setTunnelController,
  startTunnel,
  stopAttachmentWatcher,
  stopTunnel,
  tunnelController,
  tunnelSessionRequested,
  tunnelStatus
};