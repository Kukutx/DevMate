'use strict';

const { ObsidianHostBridge } = require('./bridge/server.js');
const { cleanOperationId, cleanVaultPath, propertyKey, withinFolder } = require('./bridge/path-policy.js');
const { hash } = require('./bridge/note-actions.js');
const { publicOperation } = require('./bridge/operation-store.js');

module.exports = {
  ObsidianHostBridge,
  __test: {
    cleanOperationId,
    cleanVaultPath,
    hash,
    propertyKey,
    publicOperation,
    withinFolder
  }
};
