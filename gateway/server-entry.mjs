#!/usr/bin/env node
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { installLocalCapabilities, shutdownPersistentProcesses } from './local-capabilities.mjs';
import { installPluginHost, shutdownPluginServices } from './plugins/plugin-host.mjs';
import { installHttpObservability } from './http-observability.mjs';
import { installGatewayRequestGuard, resetRequestGuardState } from './request-guard.mjs';
import { installTeamCapabilities, shutdownTeamServices } from './team-capabilities.mjs';
import { acquireGatewayInstanceLock, releaseGatewayInstanceLock } from './durable-state.mjs';

const instanceLock = acquireGatewayInstanceLock();
installHttpObservability(http);
installGatewayRequestGuard(http);
installTeamCapabilities(McpServer);
installLocalCapabilities(McpServer);
installPluginHost(McpServer);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await shutdownPluginServices(); } catch {}
  try { await shutdownTeamServices(); } catch {}
  try { await shutdownPersistentProcesses(); } catch {}
  try { resetRequestGuardState(); } catch {}
  try { releaseGatewayInstanceLock(); } catch {}
  if (signal) process.exit(0);
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('exit', () => { try { releaseGatewayInstanceLock(); } catch {} });

console.log(`DevMate instance lock acquired for ${instanceLock.instanceId || 'unknown'} (pid=${process.pid}).`);
await import('./server.mjs');
