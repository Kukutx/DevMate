import http from 'node:http';
import path from 'node:path';
import { isMainThread, parentPort } from 'node:worker_threads';
import { McpServer } from "@modelcontextprotocol/server";
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
import { drainRuntimeMaintenance, startRuntimeMaintenance, stopRuntimeMaintenance } from './runtime-maintenance.mjs';
import { beginStartupProgress, completeStartupProgress, enterStartupStage, failStartupProgress } from './startup-progress.mjs';
import { installRunnerControlPlane, resetRunnerControlState } from './runner-control-plane.mjs';

const { validatePermissionConfig } = permissionConfig;
const { strictPort } = portConfig;
const CONFIG_PATH = String(process.env.DEVMATE_CONFIG || '').trim();
const CONFIG_DIR = CONFIG_PATH ? path.dirname(CONFIG_PATH) : '';
const STATE_ROOT = CONFIG_DIR ? path.join(CONFIG_DIR, 'state') : '';
const BACKUP_ROOT = STATE_ROOT ? path.join(STATE_ROOT, 'backups') : '';
const AUDIT_LOG = STATE_ROOT ? path.join(STATE_ROOT, 'audit.jsonl') : '';
const DESKTOP_PARENT_PID = Number(process.env.DEVMATE_RUNTIME_PARENT_PID || 0);
const DESKTOP_MANAGED = Number.isInteger(DESKTOP_PARENT_PID) && DESKTOP_PARENT_PID > 0;
const LIFECYCLE_WATCH_MS = 500;

beginStartupProgress('runtime_config');

let httpBootstrap = null;
try {
  const startupConfig = readConfig();
  strictPort(startupConfig.server?.port, { label: 'server.port' });
  validatePermissionConfig(startupConfig);
  if (DESKTOP_MANAGED && startupConfig.lifecycle?.desiredState !== 'running') {
    const error = new Error('Desktop Gateway launch was cancelled because the shared DevMate lifecycle is stopped');
    error.code = 'DEVMATE_GATEWAY_LIFECYCLE_STOPPED';
    throw error;
  }
  if (startupConfig.auth?.mode === 'oauth') oauthSecrets.readOAuthSecrets(process.env.DEVMATE_CONFIG);

  enterStartupStage('instance_lock');
  acquireGatewayInstanceLock();

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

  let lifecycleWatch = null;
  let shutdownPromise = null;
  async function shutdown(reason = '') {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      if (lifecycleWatch) clearInterval(lifecycleWatch);
      lifecycleWatch = null;
      try { stopRuntimeMaintenance(); } catch {}
      try { await drainRuntimeMaintenance(); } catch {}
      try { await Promise.all([...createdHttpServers].map(server => closeHttpServer(server))); } catch {}
      try { await drainAllAuditLogs(); } catch {}
      try { await shutdownJobRuntime(); } catch {}
      try { await shutdownPluginServices(); } catch {}
      try { await shutdownTeamServices(); } catch {}
      try { await shutdownPersistentProcesses(); } catch {}
      try { await shutdownCommandProcesses(); } catch {}
      try { resetRunnerControlState(); } catch {}
      try { resetRequestGuardState(); } catch {}
      try { releaseGatewayInstanceLock(); } catch {}
      try { parentPort?.postMessage({ type: 'devmate:shutdown-complete', reason }); } catch {}
      try { if (process.connected) process.send?.({ type: 'devmate:shutdown-complete', reason }); } catch {}
    })();
    await shutdownPromise;
    return shutdownPromise;
  }

  function shutdownAndExit(reason) {
    void shutdown(reason).finally(() => process.exit(0));
  }

  process.once('SIGINT', () => shutdownAndExit('SIGINT'));
  process.once('SIGTERM', () => shutdownAndExit('SIGTERM'));
  process.once('exit', () => { try { releaseGatewayInstanceLock(); } catch {} });

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

  enterStartupStage('server_module');
  await import('./server.mjs');

  if (DESKTOP_MANAGED) {
    lifecycleWatch = setInterval(() => {
      if (shutdownPromise) return;
      try {
        if (readConfig().lifecycle?.desiredState !== 'running') shutdownAndExit('lifecycle-stopped');
      } catch {}
    }, LIFECYCLE_WATCH_MS);
    lifecycleWatch.unref?.();
  }

  startRuntimeMaintenance({
    paths: { stateRoot: STATE_ROOT, backupRoot: BACKUP_ROOT, auditLog: AUDIT_LOG },
    getOptions: () => readConfig().maintenance || {}
  });
  completeStartupProgress('server_module_loaded');
} catch (error) {
  failStartupProgress(error);
  throw error;
} finally {
  httpBootstrap?.restore();
}
