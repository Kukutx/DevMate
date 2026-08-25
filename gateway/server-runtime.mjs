import http from 'node:http';
import path from 'node:path';
import { isMainThread, parentPort } from 'node:worker_threads';
import { McpServer } from '@modelcontextprotocol/server';
import permissionConfig from '../shared/permission-config.cjs';
import oauthSecrets from '../shared/oauth-secrets.cjs';
import portConfig from '../shared/port.cjs';
import { shutdownPersistentProcesses } from './local-capabilities.mjs';
import { shutdownCommandProcesses } from './command-process.mjs';
import { drainAllAuditLogs } from './audit-log-coordinator.mjs';
import { readConfig } from './local-shared.mjs';
import { installPlatformCapabilities } from './platform-capabilities.mjs';
import { shutdownPluginServices } from './plugins/plugin-host.mjs';
import { installGatewayRequestGuard, resetRequestGuardState } from './request-guard.mjs';
import { installHttpObservability } from './http-observability.mjs';
import { installHttpServerBootstrap } from './http-server-bootstrap.mjs';
import { installLocalControlGuard } from './local-control-guard.mjs';
import { acquireGatewayInstanceLock, releaseGatewayInstanceLock } from './durable-state.mjs';
import { shutdownTeamServices } from './team-capabilities.mjs';
import { shutdownJobRuntime } from './job-runtime.mjs';
import { drainRuntimeMaintenance, runRuntimeMaintenanceOnce, startRuntimeMaintenance, stopRuntimeMaintenance } from './runtime-maintenance.mjs';
import { beginStartupProgress, completeStartupProgress, enterStartupStage, failStartupProgress } from './startup-progress.mjs';
import { installRunnerControlPlane, resetRunnerControlState } from './runner-control-plane.mjs';
import { recoverFileTransactions } from './file-transactions.mjs';
import { reconcileAgentSnapshotStorage } from './agent-snapshot.mjs';
import { clearHealthMarker, writeDegradedHealth } from './health-marker.mjs';
import { assertConfiguredWorkspaceRootsSafe } from './workspace-resolver.mjs';

const { validatePermissionConfig } = permissionConfig;
const { strictPort } = portConfig;
const CONFIG_PATH = String(process.env.DEVMATE_CONFIG || '').trim();
const CONFIG_DIR = CONFIG_PATH ? path.dirname(CONFIG_PATH) : '';
const STATE_ROOT = CONFIG_DIR ? path.join(CONFIG_DIR, 'state') : '';
const BACKUP_ROOT = STATE_ROOT ? path.join(STATE_ROOT, 'backups') : '';
const AUDIT_LOG = STATE_ROOT ? path.join(STATE_ROOT, 'audit.jsonl') : '';
const FILE_TRANSACTION_ROOT = STATE_ROOT ? path.join(STATE_ROOT, 'file-transactions') : '';
const SHUTDOWN_HEALTH = STATE_ROOT ? path.join(STATE_ROOT, 'shutdown-health.json') : '';
const DESKTOP_LIFECYCLE_FENCE = process.env.DEVMATE_DESKTOP_LIFECYCLE_FENCE === '1';
const LIFECYCLE_WATCH_MS = 500;

beginStartupProgress('runtime_config');

let httpBootstrap = null;
let instanceLockAcquired = false;
let codexCollaboration = null;
try {
  const startupConfig = readConfig();
  strictPort(startupConfig.server?.port, { label: 'server.port' });
  validatePermissionConfig(startupConfig);
  assertConfiguredWorkspaceRootsSafe(startupConfig);
  if (DESKTOP_LIFECYCLE_FENCE && startupConfig.lifecycle?.desiredState !== 'running') {
    const error = new Error('Desktop Gateway launch was cancelled because the shared DevMate lifecycle is stopped');
    error.code = 'DEVMATE_GATEWAY_LIFECYCLE_STOPPED';
    throw error;
  }
  if (startupConfig.auth?.mode === 'oauth') oauthSecrets.readOAuthSecrets(CONFIG_PATH);

  enterStartupStage('instance_lock');
  acquireGatewayInstanceLock();
  instanceLockAcquired = true;

  enterStartupStage('codex_collaboration_recovery');
  codexCollaboration = await import('./agent-collaboration.mjs');
  codexCollaboration.recoverCodexCollaborationAfterRestart();

  enterStartupStage('codex_snapshot_recovery');
  const snapshotRecovery = await reconcileAgentSnapshotStorage();
  if (snapshotRecovery.failed.length) {
    const error = new Error(`DevMate Codex snapshot cleanup is blocked for ${snapshotRecovery.failed.length} task(s)`);
    error.code = 'DEVMATE_CODEX_SNAPSHOT_RECOVERY_BLOCKED';
    error.failed = snapshotRecovery.failed;
    throw error;
  }

  enterStartupStage('file_transaction_recovery');
  const workspaceRoots = [
    ...(Array.isArray(startupConfig.workspaces) ? startupConfig.workspaces : []).map(item => item?.root),
    ...(Array.isArray(startupConfig.trustedWritableRoots) ? startupConfig.trustedWritableRoots : []).map(item => item?.root || item?.path || item)
  ].filter(Boolean);
  const fileRecovery = await recoverFileTransactions({
    transactionRoot: FILE_TRANSACTION_ROOT,
    workspaceRoots
  });
  if (fileRecovery.blocked.length) {
    const error = new Error(`DevMate file transaction recovery is blocked for ${fileRecovery.blocked.length} transaction(s)`);
    error.code = 'DEVMATE_FILE_TRANSACTION_RECOVERY_BLOCKED';
    error.blocked = fileRecovery.blocked;
    throw error;
  }

  enterStartupStage('codex_apply_recovery');
  const codexApplyRecovery = await codexCollaboration.recoverCodexApplyAfterFileTransactions();
  if (codexApplyRecovery.blocked.length) {
    const error = new Error(`DevMate Codex proposal recovery is blocked for ${codexApplyRecovery.blocked.length} task(s)`);
    error.code = 'DEVMATE_CODEX_APPLY_RECOVERY_BLOCKED';
    error.blocked = codexApplyRecovery.blocked;
    throw error;
  }

  enterStartupStage('platform_capabilities');
  const createdHttpServers = new Set();
  httpBootstrap = installHttpServerBootstrap(http, {
    installers: [
      installLocalControlGuard,
      installHttpObservability,
      installGatewayRequestGuard,
      installRunnerControlPlane
    ],
    onServer(server) {
      createdHttpServers.add(server);
      server.once?.('close', () => createdHttpServers.delete(server));
    }
  });

  function closeHttpServer(server, timeoutMs = 3000) {
    return new Promise(resolve => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        resolve();
      };
      const timer = setTimeout(() => {
        try { server.closeAllConnections?.(); } catch {}
        finish();
      }, timeoutMs);
      try {
        server.close(() => {
          clearTimeout(timer);
          finish();
        });
        try { server.closeIdleConnections?.(); } catch {}
      } catch {
        clearTimeout(timer);
        finish();
      }
    });
  }

  async function cleanupStep(failures, label, fn) {
    try {
      await fn();
    } catch (error) {
      const failure = {
        label,
        code: error?.code ? String(error.code) : null,
        message: String(error?.message || error).slice(0, 2000)
      };
      failures.push(failure);
      console.error(`DevMate shutdown cleanup failed (${label}): ${failure.message}`);
    }
  }

  let lifecycleWatch = null;
  let shutdownPromise = null;
  async function shutdown(reason = '') {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const failures = [];
      if (lifecycleWatch) clearInterval(lifecycleWatch);
      lifecycleWatch = null;
      await cleanupStep(failures, 'stop-runtime-maintenance', async () => stopRuntimeMaintenance());
      await cleanupStep(failures, 'drain-runtime-maintenance', () => drainRuntimeMaintenance());
      await cleanupStep(failures, 'close-http', () => Promise.all([...createdHttpServers].map(server => closeHttpServer(server))));
      await cleanupStep(failures, 'drain-audit', () => drainAllAuditLogs());
      await cleanupStep(failures, 'codex-collaboration', async () => codexCollaboration?.shutdownCodexCollaboration?.());
      await cleanupStep(failures, 'jobs', () => shutdownJobRuntime());
      await cleanupStep(failures, 'plugins', () => shutdownPluginServices());
      await cleanupStep(failures, 'team', () => shutdownTeamServices());
      await cleanupStep(failures, 'persistent-processes', () => shutdownPersistentProcesses());
      await cleanupStep(failures, 'command-processes', () => shutdownCommandProcesses());
      await cleanupStep(failures, 'runner-control', async () => resetRunnerControlState());
      await cleanupStep(failures, 'request-guard', async () => resetRequestGuardState());
      await cleanupStep(failures, 'instance-lock', async () => {
        releaseGatewayInstanceLock();
        instanceLockAcquired = false;
      });
      await cleanupStep(failures, 'parent-port-notify', async () => parentPort?.postMessage({ type: 'devmate:shutdown-complete', reason, degraded: failures.length > 0 }));
      await cleanupStep(failures, 'parent-process-notify', async () => {
        if (process.connected) process.send?.({ type: 'devmate:shutdown-complete', reason, degraded: failures.length > 0 });
      });

      if (failures.length) {
        const error = new Error(`DevMate shutdown completed with ${failures.length} cleanup failure(s)`);
        error.code = 'DEVMATE_SHUTDOWN_DEGRADED';
        error.failures = failures;
        await writeDegradedHealth(SHUTDOWN_HEALTH, error);
      } else {
        await clearHealthMarker(SHUTDOWN_HEALTH);
      }
      return { reason, failures };
    })();
    return shutdownPromise;
  }

  function shutdownAndExit(reason) {
    void shutdown(reason).then(
      result => process.exit(result.failures.length ? 1 : 0),
      error => {
        console.error(`DevMate shutdown failed: ${error?.message || error}`);
        process.exit(1);
      }
    );
  }

  process.once('SIGINT', () => shutdownAndExit('SIGINT'));
  process.once('SIGTERM', () => shutdownAndExit('SIGTERM'));
  process.once('exit', () => {
    if (!instanceLockAcquired) return;
    try { releaseGatewayInstanceLock(); } catch {}
  });

  if (typeof process.send === 'function') {
    process.once('disconnect', () => shutdownAndExit('parent-disconnect'));
    process.on('message', message => {
      if (message?.type !== 'devmate:shutdown') return;
      const expectedOwner = String(process.env.DEVMATE_RUNTIME_OWNER_ID || '');
      const requestedOwner = String(message.runtimeOwnerId || '');
      if (requestedOwner && expectedOwner && requestedOwner !== expectedOwner) return;
      shutdownAndExit(message.signal || 'parent-message');
    });
  }

  if (!isMainThread && parentPort) {
    parentPort.on('message', message => {
      if (message?.type !== 'devmate:shutdown') return;
      const expectedOwner = String(process.env.DEVMATE_RUNTIME_OWNER_ID || '');
      const requestedOwner = String(message.runtimeOwnerId || '');
      if (requestedOwner && expectedOwner && requestedOwner !== expectedOwner) return;
      shutdownAndExit(message.signal || 'worker-message');
    });
  }

  installPlatformCapabilities(McpServer);
  codexCollaboration.installCodexCollaborationCapability(McpServer);

  enterStartupStage('server_module');
  await import('./server.mjs');

  if (DESKTOP_LIFECYCLE_FENCE) {
    lifecycleWatch = setInterval(() => {
      if (shutdownPromise) return;
      try {
        if (readConfig().lifecycle?.desiredState !== 'running') shutdownAndExit('lifecycle-stopped');
      } catch (error) {
        console.error(`DevMate lifecycle config became unavailable: ${error?.message || error}`);
        shutdownAndExit('lifecycle-config-unavailable');
      }
    }, LIFECYCLE_WATCH_MS);
    lifecycleWatch.unref?.();
  }

  startRuntimeMaintenance({
    paths: { stateRoot: STATE_ROOT, backupRoot: BACKUP_ROOT, auditLog: AUDIT_LOG, configFile: CONFIG_PATH },
    getOptions: () => readConfig().maintenance || {}
  });
  completeStartupProgress('server_module_loaded');
  setImmediate(() => {
    void runRuntimeMaintenanceOnce({ force: true }).catch(error => {
      console.error(`Initial runtime maintenance failed: ${error?.message || error}`);
    });
  });
} catch (error) {
  if (instanceLockAcquired) {
    try { releaseGatewayInstanceLock(); } catch {}
    instanceLockAcquired = false;
  }
  failStartupProgress(error);
  throw error;
} finally {
  httpBootstrap?.restore();
}
