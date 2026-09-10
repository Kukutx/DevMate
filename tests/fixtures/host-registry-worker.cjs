'use strict';

const { updateConfig } = require('../../shared/config-store.cjs');
const { publishHostContext } = require('../../shared/host-registry.cjs');

const [, , configFile, hostId, focusedValue, workspaceRoot] = process.argv;
if (!configFile || !hostId) throw new Error('configFile and hostId are required');

updateConfig(configFile, config => {
  publishHostContext(config, hostId, {
    kind: hostId.startsWith('obsidian-') ? 'knowledge-base' : 'editor',
    focused: focusedValue === 'true',
    workspaceRoot: workspaceRoot || hostId,
    pid: process.pid,
    updatedAt: new Date().toISOString()
  });
  return config;
});
