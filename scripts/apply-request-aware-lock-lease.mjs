#!/usr/bin/env node
import fs from 'node:fs';

const file = 'gateway/durable-state.mjs';
let source = fs.readFileSync(file, 'utf8');

function replaceOnce(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  source = source.replace(before, after);
}

replaceOnce(
  "export const INSTANCE_LOCK_LEASE_MS = 30000;\nexport const INSTANCE_LOCK_HEARTBEAT_MS = 5000;",
  "export const INSTANCE_LOCK_LEASE_MS = 20 * 60 * 1000;\nexport const INSTANCE_LOCK_LEASE_MARGIN_MS = 60 * 1000;\nexport const INSTANCE_LOCK_HEARTBEAT_MS = 5000;",
  'instance lease constants'
);

replaceOnce(
  "export function acquireGatewayInstanceLock({\n  timeoutMs = INSTANCE_LOCK_ACQUIRE_TIMEOUT_MS,\n  leaseMs = INSTANCE_LOCK_LEASE_MS\n} = {}) {\n  const runtimeOwnerId = String(process.env.DEVMATE_RUNTIME_OWNER_ID || `process-${process.pid}`);",
  `export function configuredGatewayInstanceLeaseMs(config, requestedLeaseMs = null) {\n  if (requestedLeaseMs != null) {\n    return Math.max(5000, Number(requestedLeaseMs) || INSTANCE_LOCK_LEASE_MS);\n  }\n  const configuredRequestMs = Math.max(\n    Number(config?.production?.requestTimeoutMs) || 0,\n    Number(config?.runtime?.defaultCommandTimeoutMs) || 0\n  );\n  return Math.max(\n    INSTANCE_LOCK_LEASE_MS,\n    configuredRequestMs > 0 ? configuredRequestMs + INSTANCE_LOCK_LEASE_MARGIN_MS : 0\n  );\n}\n\nexport function acquireGatewayInstanceLock({\n  timeoutMs = INSTANCE_LOCK_ACQUIRE_TIMEOUT_MS,\n  leaseMs = null\n} = {}) {\n  const runtimeOwnerId = String(process.env.DEVMATE_RUNTIME_OWNER_ID || \`process-\${process.pid}\`);\n  const config = readConfig();\n  const effectiveLeaseMs = configuredGatewayInstanceLeaseMs(config, leaseMs);`,
  'request-aware lease helper'
);

replaceOnce(
  "      leaseMs\n    };",
  "      leaseMs: effectiveLeaseMs\n    };",
  'disabled lock lease'
);

replaceOnce(
  "  ensureStateRoot();\n  const config = readConfig();\n  const acquiredAt = now();",
  "  ensureStateRoot();\n  const acquiredAt = now();",
  'deduplicate config read'
);

replaceOnce(
  "    leaseMs: Math.max(5000, Number(leaseMs) || INSTANCE_LOCK_LEASE_MS)",
  "    leaseMs: effectiveLeaseMs",
  'persist effective lease'
);

fs.writeFileSync(file, source, 'utf8');
console.log('Applied request-aware Gateway instance lock lease.');
