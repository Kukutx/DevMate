import http from 'node:http';
import { isMainThread, parentPort } from 'node:worker_threads';
import { McpServer } from "@modelcontextprotocol/server";
import permissionConfig from '../shared/permission-config.cjs';
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
import { shutdownJobRuntime, startJobRuntime } from './job-runtime.mjs';
import { installRunnerControlPlane, resetRunnerControlState } from './runner-control-plane.mjs';

const { validatePermissionConfig } = permissionConfig;
const { strictPort } = portConfig;
const startupConfig = readConfig();
strictPort(startupConfig.server?.port, { label: 'server.port' });
validatePermissionConfig(startupConfig);
acquireGatewayInstanceLock();

const createdHttpServers = new Set();
const httpBootstrap = installHttpServerBootstrap(http, {
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

let shutdownPromise = null;
async function shutdown(reason = '') {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
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

if (!isMainThread && parentPort) {
  parentPort.on('message', message => {
    if (message?.type !== 'devmate:shutdown') return;
    const expectedOwner = String(process.env.DEVMATE_RUNTIME_OWNER_ID || '');
    const requestedOwner = String(message.runtimeOwnerId || '');
    if (requestedOwner && expectedOwner && requestedOwner !== expectedOwner) return;
    shutdownAndExit(message.signal || 'worker-message');
  });
}

try {
  installPlatformCapabilities(McpServer);
  if (process.env.DEVMATE_DISABLE_EMBEDDED_RUNNER !== '1' && readConfig().jobs?.embeddedRunnerEnabled === true) startJobRuntime();
  await import('./server.mjs');
} finally {
  httpBootstrap.restore();
}

