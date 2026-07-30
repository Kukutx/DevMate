#!/usr/bin/env node
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { installLocalCapabilities, shutdownPersistentProcesses } from './local-capabilities.mjs';
import { installPluginHost, shutdownPluginServices } from './plugins/plugin-host.mjs';
import { installGatewayRequestGuard, resetRequestGuardState } from './request-guard.mjs';
import { installTeamCapabilities, shutdownTeamServices } from './team-capabilities.mjs';

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
  if (signal) process.exit(0);
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

await import('./server.mjs');
