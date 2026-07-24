#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { installLocalCapabilities, shutdownPersistentProcesses } from './local-capabilities.mjs';

installLocalCapabilities(McpServer);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await shutdownPersistentProcesses(); } catch {}
  if (signal) process.exit(0);
}
process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

await import('./server.mjs');
