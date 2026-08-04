'use strict';

const { MAX_OPERATION_RECORDS } = require('./constants.js');
const { JsonRecordStore } = require('./record-store.js');

function publicOperation(record) {
  return {
    id: record.id,
    action: record.action,
    path: record.path || null,
    destination: record.destination || null,
    batchPlanId: record.batchPlanId || null,
    createdAt: record.createdAt,
    rolledBackAt: record.rolledBackAt || null
  };
}

class OperationStore extends JsonRecordStore {
  constructor(controller) {
    super({
      stateDirectory: controller.stateDirectory,
      relativeDirectory: 'host-operations/obsidian',
      idPrefix: 'obs',
      maxRecords: MAX_OPERATION_RECORDS
    });
  }

  listPublic(limit = 50) {
    return this.list(limit).map(publicOperation);
  }
}

module.exports = {
  OperationStore,
  publicOperation
};
