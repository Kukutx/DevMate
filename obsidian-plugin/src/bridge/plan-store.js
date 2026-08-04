'use strict';

const { MAX_PLAN_RECORDS } = require('./constants.js');
const { JsonRecordStore } = require('./record-store.js');

function publicPlan(record) {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    files: record.items?.length || 0,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    appliedAt: record.appliedAt || null,
    rolledBackAt: record.rolledBackAt || null,
    operationIds: record.operationIds || [],
    error: record.error || null
  };
}

class PlanStore extends JsonRecordStore {
  constructor(controller) {
    super({
      stateDirectory: controller.stateDirectory,
      relativeDirectory: 'host-plans/obsidian',
      idPrefix: 'obp',
      maxRecords: MAX_PLAN_RECORDS
    });
  }

  listPublic(limit = 50) {
    return this.list(limit).map(publicPlan);
  }
}

module.exports = {
  PlanStore,
  publicPlan
};
