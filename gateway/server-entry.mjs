#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { installLocalCapabilities, shutdownPersistentProcesses } from './local-capabilities.mjs';
import { installPluginHost, shutdownPluginServices } from './plugins/plugin-host.mjs';

installLocalCapabilities(McpServer);
installPluginHost(McpServer);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await shutdownPluginServices(); } catch {}
  try { await shutdownPersistentProcesses(); } catch {}
  if (signal) process.exit(0);
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

await import('./server.mjs');
