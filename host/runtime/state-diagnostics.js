'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_RUNTIME_STATE_DIAGNOSTIC_BYTES = 256 * 1024;

function requiredDirectory(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('stateDirectory is required');
  return path.resolve(text);
}

function readBoundedJson(file, maxBytes = MAX_RUNTIME_STATE_DIAGNOSTIC_BYTES) {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > maxBytes) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function runtimeStateDiagnosticPaths(stateDirectory) {
  const stateRoot = path.join(requiredDirectory(stateDirectory), 'state');
  return {
    stateRoot,
    startupProgressFile: path.join(stateRoot, 'gateway-startup.json'),
    auditHealthFile: path.join(stateRoot, 'audit-health.json'),
    runtimeMaintenanceHealthFile: path.join(stateRoot, 'runtime-maintenance.json')
  };
}

function runtimeStateDiagnostics(stateDirectory) {
  const paths = runtimeStateDiagnosticPaths(stateDirectory);
  return {
    startupProgress: readBoundedJson(paths.startupProgressFile),
    auditHealth: readBoundedJson(paths.auditHealthFile),
    runtimeMaintenanceHealth: readBoundedJson(paths.runtimeMaintenanceHealthFile)
  };
}

module.exports = {
  MAX_RUNTIME_STATE_DIAGNOSTIC_BYTES,
  readBoundedJson,
  runtimeStateDiagnosticPaths,
  runtimeStateDiagnostics
};
