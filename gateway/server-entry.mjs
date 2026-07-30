#!/usr/bin/env node
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { installLocalCapabilities, shutdownPersistentProcesses } from './local-capabilities.mjs';
import { installPluginHost, shutdownPluginServices } from './plugins/plugin-host.mjs';
import { installGatewayRequestGuard, resetRequestGuardState } from './request-guard.mjs';
import { installHttpObservability } from './http-observability.mjs';
import { acquireGatewayInstanceLock, releaseGatewayInstanceLock } from './durable-state.mjs';
import { installTeamCapabilities, shutdownTeamServices } from './team-capabilities.mjs';
import { shutdownJobRuntime, startJobRuntime } from './job-runtime.mjs';
import { installRunnerControlPlane, resetRunnerControlState } from './runner-control-plane.mjs';
import { installRunnerCapabilities } from './runner-capabilities.mjs';

acquireGatewayInstanceLock();
installHttpObservability(http);
installGatewayRequestGuard(http);
installRunnerControlPlane(http);
installTeamCapabilities(McpServer);
installRunnerCapabilities(McpServer);
installLocalCapabilities(McpServer);
installPluginHost(McpServer);
startJobRuntime();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await shutdownJobRuntime(); } catch {}
  try { await shutdownPluginServices(); } catch {}
  try { await shutdownTeamServices(); } catch {}
  try { await shutdownPersistentProcesses(); } catch {}
  try { resetRunnerControlState(); } catch {}
  try { resetRequestGuardState(); } catch {}
  try { releaseGatewayInstanceLock(); } catch {}
  if (signal) process.exit(0);
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('exit', () => { try { releaseGatewayInstanceLock(); } catch {} });

await import('./server.mjs');
