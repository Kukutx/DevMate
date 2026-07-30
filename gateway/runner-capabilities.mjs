import { z } from 'zod';
import { registerRunnerTools } from './runner-tools.mjs';

const INSTALLED = Symbol.for('devmate.runnerCapabilitiesInstalled');
const REGISTERED = Symbol.for('devmate.runnerToolsRegistered');

function registerTools(server) {
  if (server[REGISTERED]) return;
  server[REGISTERED] = true;
  const register = (name, config, handler) => server.registerTool(name, {
    outputSchema: z.object({}).passthrough(),
    ...config
  }, handler);
  registerRunnerTools(register, {
    ro: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    rw: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  });
}

export function installRunnerCapabilities(McpServerClass) {
  if (McpServerClass.prototype[INSTALLED]) return;
  const originalConnect = McpServerClass.prototype.connect;
  Object.defineProperty(McpServerClass.prototype, INSTALLED, { value: true });
  McpServerClass.prototype.connect = async function runnerCapabilitiesConnect(...args) {
    registerTools(this);
    return originalConnect.apply(this, args);
  };
}

export const __test = { registerTools };
