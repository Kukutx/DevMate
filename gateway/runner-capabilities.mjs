import { z } from 'zod';
import { registerServerInitializer } from './server-extension-host.mjs';
import { registerRunnerTools } from './runner-tools.mjs';

const REGISTERED = Symbol.for('devmate.runnerToolsRegistered');

export function registerRunnerCapabilityTools(server) {
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
  registerServerInitializer(McpServerClass, {
    id: 'devmate.runner-tools',
    order: 20,
    initialize: registerRunnerCapabilityTools
  });
}

export const __test = { registerRunnerCapabilityTools };
