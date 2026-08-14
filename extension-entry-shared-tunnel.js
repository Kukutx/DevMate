'use strict';

const path = require('node:path');
const vscode = require('vscode');
const { version: VERSION } = require('./package.json');
const { ensureInstanceConfig, readJson } = require('./shared/config-store.cjs');
const { OperationCoordinator } = require('./host/runtime/operation-coordinator.js');
const { preflightPublicMcp } = require('./host/public-mcp.js');
const { strictPort } = require('./shared/port.cjs');
const { VscodeHostLifecycle } = require('./vscode-host/lifecycle.js');
const { settingsFromState } = require('./vscode-host/effective-tunnel-settings.js');
const { PublicTunnelVerifier } = require('./vscode-host/public-tunnel-verifier.js');
const { currentWorkspaceRoot, resolveVscodeStateDirectory, setting } = require('./vscode-host/runtime-context.js');
const { TunnelController } = require('./vscode-host/tunnel-controller.js');
const { resolveTunnelExecutable } = require('./vscode-host/tunnel-executable.js');
const {
  clearTunnelController,
  setTunnelController,
  tunnelSessionRequested
} = require('./vscode-host/tunnel-runtime.js');
const { tunnelMaxRestarts } = require('./vscode-host/tunnel-settings.js');

const NGROK_TOKEN_SECRET = 'devMate.ngrokAuthtoken';
const CLOUDFLARE_TOKEN_SECRET = 'devMate.cloudflareTunnelToken';
const SESSION_RECOVERY_POLL_MS = 5000;
const SESSION_RECOVERY_RETRY_MS = 30000;

let lifecycle = null;
let runtime = null;
let publicVerifier = null;
let output = null;
const hostLifecycleOperations = new OperationCoordinator({ name: 'shared-tunnel-host-lifecycle' });
let runtimeStateDirectory = '';
let sessionRecoveryTimer = null;
let sessionRecoveryPromise = null;
let sessionRecoveryNextAt = 0;
let sessionRecoveryEpoch = 0;

function strictBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function localTunnelSettings() {
  return {
    publicUrl: setting(vscode, 'publicUrl', ''),
    ngrokUrl: setting(vscode, 'ngrokUrl', ''),
    ngrokCommandPath: resolveTunnelExecutable('ngrok', setting(vscode, 'ngrokCommandPath', '')),
    ngrokUseManagedAccount: strictBoolean(setting(vscode, 'ngrokUseManagedAccount', false), 'ngrokUseManagedAccount'),
    ngrokPoolingEnabled: strictBoolean(setting(vscode, 'ngrokPoolingEnabled', false), 'ngrokPoolingEnabled'),
    ngrokTrafficPolicyFile: setting(vscode, 'ngrokTrafficPolicyFile', ''),
    cloudflareCommandPath: resolveTunnelExecutable('cloudflared', setting(vscode, 'cloudflareCommandPath', '')),
    autoRestart: strictBoolean(setting(vscode, 'tunnelAutoRestart', true), 'tunnelAutoRestart'),
    maxRestarts: tunnelMaxRestarts(setting(vscode, 'tunnelMaxRestarts', 10))
  };
}

function tunnelSettings(stateDirectory = runtimeStateDirectory) {
  return settingsFromState({ stateDirectory, localSettings: localTunnelSettings() });
}

function log(message) {
  output?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function ensureSharedDesktopConfig(stateDirectory) {
  const workspaceRoot = currentWorkspaceRoot(vscode);
  if (!workspaceRoot) return null;
  const configFile = path.join(stateDirectory, 'config.json');
  ensureInstanceConfig({
    configFile,
    workspaceRoot,
    preferredPort: strictPort(setting(vscode, 'port', 8787), { label: 'devMate.port' }),
    appVersion: VERSION
  });
  return configFile;
}

async function tunnelSecrets(context) {
  const [ngrokAuthtoken, cloudflareTunnelToken] = await Promise.all([
    context.secrets.get(NGROK_TOKEN_SECRET),
    context.secrets.get(CLOUDFLARE_TOKEN_SECRET)
  ]);
  return {
    ngrokAuthtoken: ngrokAuthtoken || '',
    cloudflareTunnelToken: cloudflareTunnelToken || ''
  };
}

async function syncBasePublicState() {
  try {
    return await vscode.commands.executeCommand('devMate.syncPublicState');
  } catch (error) {
    log(`Could not synchronize base VS Code public state: ${error.message || error}`);
    return null;
  }
}

async function stopConfigurationConflict() {
  if (!runtime) return { stopped: false, reason: 'runtime-unavailable' };
  const result = await runtime.stop();
  await syncBasePublicState();
  if (result.stopped) {
    if (tunnelSessionRequested()) {
      log('Stopped the stale public connection; the requested DevMate session will recover with the current shared connection configuration.');
    } else {
      const choice = await vscode.window.showWarningMessage(
        'DevMate stopped the previous public connection because the shared connection configuration changed.',
        'Start Now',
        'Open DevMate'
      );
      if (choice === 'Start Now') await vscode.commands.executeCommand('devMate.start');
      if (choice === 'Open DevMate') await vscode.commands.executeCommand('devMate.open');
    }
  } else if (result.reason === 'managed-by-another-host') {
    log('The mismatched public connection is owned by another host; its owner must reconcile the shared configuration.');
  } else if (result.reason && result.reason !== 'not-running') {
    vscode.window.showWarningMessage(`DevMate could not stop the stale public connection cleanly: ${result.reason}`);
  }
  return result;
}

async function verifyAlreadyOnlineNgrokEndpoint({ publicUrl }) {
  const config = readJson(path.join(runtimeStateDirectory, 'config.json'), null, { strict: true, supportedVersion: true });
  if (!config) return false;
  const token = config.auth?.required === false ? '' : String(config.auth?.token || '');
  const test = await preflightPublicMcp({
    publicUrl,
    token,
    clientName: 'devmate-ngrok-conflict-adoption',
    clientVersion: VERSION,
    timeoutMs: 5000
  });
  return test?.server?.name === 'devmate' && Number(test?.toolCount || 0) > 0;
}

function createPublicVerifier() {
  return new PublicTunnelVerifier({
    stateDirectory: runtimeStateDirectory,
    tunnelStatus: port => runtime?.status(port),
    appVersion: VERSION,
    logger: log,
    onStateChange: async () => {
      await syncBasePublicState();
    },
    onConfigurationConflict: async () => stopConfigurationConflict(),
    onVerified: async result => {
      if (!result.changedHost) return;
      const choice = await vscode.window.showWarningMessage(
        `DevMate recovered a new verified public endpoint (${result.publicHost}). Update the ChatGPT MCP connection to the new URL.`,
        'Copy MCP URL',
        'Open DevMate'
      );
      if (choice === 'Copy MCP URL') await vscode.commands.executeCommand('devMate.copyUrl');
      if (choice === 'Open DevMate') await vscode.commands.executeCommand('devMate.open');
    },
    onError: async ({ error }) => {
      const choice = await vscode.window.showWarningMessage(
        `DevMate public connection recovered, but MCP verification failed: ${error.message || error}`,
        'Open DevMate',
        'Copy diagnostics'
      );
      if (choice === 'Open DevMate') await vscode.commands.executeCommand('devMate.open');
      if (choice === 'Copy diagnostics') await vscode.commands.executeCommand('devMate.copyHostDiagnostics');
    }
  });
}

function stopSessionRecoveryWatcher() {
  if (sessionRecoveryTimer) clearInterval(sessionRecoveryTimer);
  sessionRecoveryTimer = null;
  sessionRecoveryEpoch += 1;
  sessionRecoveryNextAt = 0;
}

function requestedSessionNeedsRecovery() {
  if (!runtime || !runtimeStateDirectory || !tunnelSessionRequested()) return false;
  const config = readJson(path.join(runtimeStateDirectory, 'config.json'), null, { strict: true, supportedVersion: true });
  const port = Number(config?.server?.port || 0);
  if (!Number.isInteger(port) || port <= 0) return false;
  const status = runtime.status(port);
  if (!status?.running) return true;
  if (status.record?.status === 'ready' && !String(status.record?.gatewayGeneration || '').trim()) return true;
  return false;
}

async function recoverRequestedSession(expectedEpoch = sessionRecoveryEpoch) {
  if (expectedEpoch !== sessionRecoveryEpoch) return { recovered: false, reason: 'stale-lifecycle' };
  if (!runtime || !lifecycle || !tunnelSessionRequested()) return { recovered: false, reason: 'not-requested' };
  if (!requestedSessionNeedsRecovery()) return { recovered: false, reason: 'healthy-or-verifier-owned' };
  log('Recovering requested DevMate desktop session through the complete Start lifecycle.');
  const result = await vscode.commands.executeCommand('devMate.start', { quiet: true });
  if (expectedEpoch !== sessionRecoveryEpoch || !runtime || !lifecycle || !tunnelSessionRequested()) {
    return { recovered: false, reason: 'stale-lifecycle' };
  }
  if (result?.ok === false || !result?.mcpUrl || Number(result?.toolCount || 0) <= 0) {
    const error = new Error(result?.error || 'DevMate recovery Start did not reach verified Ready state');
    error.code = result?.code || 'DEVMATE_SESSION_RECOVERY_NOT_READY';
    throw error;
  }
  sessionRecoveryNextAt = 0;
  log(`Recovered requested DevMate desktop session; tools=${result.toolCount}.`);
  return { recovered: true, result };
}

function startSessionRecoveryWatcher() {
  stopSessionRecoveryWatcher();
  const epoch = sessionRecoveryEpoch;
  sessionRecoveryTimer = setInterval(() => {
    if (sessionRecoveryPromise || Date.now() < sessionRecoveryNextAt || !tunnelSessionRequested()) return;
    if (epoch !== sessionRecoveryEpoch) return;
    let needsRecovery = false;
    try {
      needsRecovery = requestedSessionNeedsRecovery();
    } catch (error) {
      log(`DevMate session recovery check failed: ${error.message || error}`);
      sessionRecoveryNextAt = Date.now() + SESSION_RECOVERY_RETRY_MS;
      return;
    }
    if (!needsRecovery) return;
    let recovery;
    recovery = recoverRequestedSession(epoch)
      .catch(error => {
        if (epoch !== sessionRecoveryEpoch) return null;
        sessionRecoveryNextAt = Date.now() + SESSION_RECOVERY_RETRY_MS;
        log(`DevMate session recovery failed: ${error.message || error}`);
        return null;
      })
      .finally(() => {
        if (sessionRecoveryPromise === recovery) sessionRecoveryPromise = null;
      });
    sessionRecoveryPromise = recovery;
  }, SESSION_RECOVERY_POLL_MS);
  sessionRecoveryTimer.unref?.();
}

async function activateInternal(context) {
  if (runtime || lifecycle || publicVerifier) {
    await deactivateInternal();
    if (runtime || lifecycle || publicVerifier) {
      const error = new Error('Previous DevMate public connection teardown is still incomplete; refusing to create a second shared tunnel controller.');
      error.code = 'DEVMATE_PREVIOUS_TUNNEL_TEARDOWN_PENDING';
      throw error;
    }
  }
  output = vscode.window.createOutputChannel('DevMate Tunnel');
  context.subscriptions.push(output);
    lifecycle = new VscodeHostLifecycle({
      vscode,
      runtimeSnapshot: () => ({
        tunnel: runtime?.diagnosticSnapshot?.() || null,
        sessionRecovery: {
          requested: tunnelSessionRequested(),
          inFlight: !!sessionRecoveryPromise,
          nextAttemptAt: sessionRecoveryNextAt || 0
        }
      })
    });
  try {
    runtimeStateDirectory = resolveVscodeStateDirectory(vscode, context);
    localTunnelSettings();
    ensureSharedDesktopConfig(runtimeStateDirectory);
    runtime = new TunnelController({
      stateDirectory: runtimeStateDirectory,
      settings: () => tunnelSettings(runtimeStateDirectory),
      getSecrets: () => tunnelSecrets(context),
      verifyExistingEndpoint: verifyAlreadyOnlineNgrokEndpoint,
      hostId: `vscode-${process.pid}`,
      logger: log
    });
    setTunnelController(runtime);
    await lifecycle.activate(context);
    publicVerifier = createPublicVerifier().start();
    startSessionRecoveryWatcher();
    log(`Provider-native shared public connection runtime ready in ${runtimeStateDirectory}.`);
  } catch (error) {
    try {
      await deactivateInternal();
    } catch (cleanupError) {
      log(`Shared tunnel cleanup after activation failure reported: ${cleanupError.message || cleanupError}`);
    }
    throw error;
  }
}

async function deactivateInternal() {
  stopSessionRecoveryWatcher();
  const currentVerifier = publicVerifier;
  const currentRuntime = runtime;
  const currentLifecycle = lifecycle;
  const currentStateDirectory = runtimeStateDirectory;
  publicVerifier = null;
  runtime = null;
  lifecycle = null;
  currentVerifier?.dispose();
  if (currentRuntime) setTunnelController(currentRuntime);
  let lifecycleResult = null;
  let directStopResult = null;
  try {
    if (currentLifecycle) {
      lifecycleResult = await currentLifecycle.deactivate();
    } else if (currentRuntime) {
      try {
        directStopResult = await currentRuntime.stop();
      } catch (error) {
        log(`Retrying retained public connection shutdown reported: ${error.message || error}`);
      }
    }
  } finally {
    let disposed = null;
    try { disposed = await currentRuntime?.dispose({ stopOwned: false }); }
    catch (error) { log(`Tunnel controller disposal failed during teardown: ${error.message || error}`); }
    if (disposed?.disposed === false) {
      runtime = currentRuntime;
      runtimeStateDirectory = currentStateDirectory;
      if (currentRuntime) setTunnelController(currentRuntime);
      log(`Preserving active public connection controller after incomplete teardown: ${disposed.reason || 'stop not confirmed'}.`);
    } else {
      clearTunnelController(currentRuntime);
      runtimeStateDirectory = '';
    }
    output = null;
  }
  return lifecycleResult || directStopResult;
}

function activate(context) {
  return hostLifecycleOperations.run('activate', () => activateInternal(context));
}

function deactivate() {
  return hostLifecycleOperations.run('deactivate', () => deactivateInternal());
}

module.exports = {
  SESSION_RECOVERY_POLL_MS,
  SESSION_RECOVERY_RETRY_MS,
  activate,
  createPublicVerifier,
  deactivate,
  deactivateInternal,
  ensureSharedDesktopConfig,
  localTunnelSettings,
  recoverRequestedSession,
  requestedSessionNeedsRecovery,
  startSessionRecoveryWatcher,
  stopConfigurationConflict,
  stopSessionRecoveryWatcher,
  syncBasePublicState,
  tunnelSecrets,
  tunnelSettings,
  verifyAlreadyOnlineNgrokEndpoint
};
