'use strict';

function publicOperation(record) {
  return {
    id: record.id,
    action: record.action,
    status: record.status,
    path: record.path || null,
    destination: record.destination || null,
    batchPlanId: record.batchPlanId || null,
    createdAt: record.createdAt,
    rolledBackAt: record.rolledBackAt || null
  };
}

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

module.exports={publicOperation,publicPlan};
