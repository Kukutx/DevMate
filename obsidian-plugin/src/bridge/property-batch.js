'use strict';

const { MAX_BATCH_FILES, PLAN_TTL_MS } = require('./constants.js');
const { publicPlan } = require('./plan-store.js');
const {
  fileSnapshot,
  normalizePropertyChange,
  now,
  requireMarkdownFile,
  rollbackOperation,
  updateProperties
} = require('./note-actions.js');
const { normalizeSelector } = require('./vault-index-core.js');
const { assertPlanReady, propertyPreview, serializedSelector } = require('./property-batch-core.js');

async function previewPropertiesBatch(plugin, index, planStore, args = {}) {
  const selector = normalizeSelector(args.selector || args);
  const change = normalizePropertyChange(args);
  const records = index.selectedRecords(args.selector || args);
  if (records.length > MAX_BATCH_FILES) {
    throw new Error(`Batch matches ${records.length} notes; refine the selector to at most ${MAX_BATCH_FILES}`);
  }

  const items = [];
  for (const record of records) {
    const preview = propertyPreview(record.properties, change);
    if (!preview.changed) continue;
    const file = requireMarkdownFile(plugin.app.vault, record.path);
    const snapshot = await fileSnapshot(plugin.app.vault, file, { includeContent: false });
    items.push({
      path: record.path,
      expectedHash: snapshot.hash,
      expectedMtime: snapshot.mtime,
      before: preview.before,
      after: preview.after
    });
  }

  if (!items.length) {
    return {
      planned: false,
      noChanges: true,
      matched: records.length,
      changed: 0,
      selector: serializedSelector(selector),
      change
    };
  }

  const createdAt = now();
  const plan = {
    id: planStore.createId(),
    kind: 'properties_batch',
    status: 'ready',
    createdAt,
    expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
    selector: serializedSelector(selector),
    change,
    items,
    operationIds: []
  };
  planStore.write(plan);
  return {
    planned: true,
    plan: publicPlan(plan),
    matched: records.length,
    changed: items.length,
    preview: items.map(item => ({ path: item.path, before: item.before, after: item.after }))
  };
}

async function preflightPlan(plugin, plan) {
  const conflicts = [];
  for (const item of plan.items || []) {
    try {
      const file = requireMarkdownFile(plugin.app.vault, item.path);
      const snapshot = await fileSnapshot(plugin.app.vault, file, { includeContent: false });
      if (snapshot.hash !== item.expectedHash) {
        conflicts.push({ path: item.path, reason: 'content_changed', expectedHash: item.expectedHash, currentHash: snapshot.hash });
      }
    } catch (error) {
      conflicts.push({ path: item.path, reason: 'unavailable', error: error.message || String(error) });
    }
  }
  return conflicts;
}

async function rollbackOperationIds(plugin, operationStore, operationIds, force = false) {
  const rolledBack = [];
  const failures = [];
  for (const operationId of [...operationIds].reverse()) {
    try {
      await rollbackOperation(plugin, operationStore, { operationId, force });
      rolledBack.push(operationId);
    } catch (error) {
      failures.push({ operationId, error: error.message || String(error) });
    }
  }
  return { rolledBack, failures };
}

async function applyPropertiesBatch(plugin, operationStore, planStore, args = {}) {
  const plan = planStore.read(args.planId);
  if (plan.status === 'applied') {
    return { applied: true, alreadyApplied: true, status: 'applied', files: plan.operationIds?.length || 0, plan: publicPlan(plan) };
  }
  if (plan.status === 'applying') {
    return {
      applied: false,
      recoveryRequired: true,
      status: 'applying',
      plan: publicPlan(plan),
      message: 'A previous apply attempt did not finish. Roll back this plan before retrying.'
    };
  }
  assertPlanReady(plan);
  const conflicts = await preflightPlan(plugin, plan);
  if (conflicts.length) {
    plan.status = 'conflict';
    plan.lastConflictAt = now();
    plan.conflicts = conflicts;
    planStore.write(plan);
    return { applied: false, status: 'conflict', plan: publicPlan(plan), conflicts };
  }

  plan.status = 'applying';
  plan.applyStartedAt = now();
  plan.conflicts = [];
  planStore.write(plan);
  const operationIds = [];
  try {
    for (const item of plan.items || []) {
      const result = await updateProperties(plugin, operationStore, {
        path: item.path,
        set: plan.change.set,
        remove: plan.change.remove
      }, { batchPlanId: plan.id });
      operationIds.push(result.operation.id);
      plan.operationIds = [...operationIds];
      planStore.write(plan);
    }
  } catch (error) {
    const rollback = await rollbackOperationIds(plugin, operationStore, operationIds, false);
    plan.operationIds = operationIds;
    plan.status = rollback.failures.length ? 'partial_failure' : 'rolled_back_after_failure';
    plan.error = error.message || String(error);
    plan.rollback = rollback;
    plan.failedAt = now();
    planStore.write(plan);
    return {
      applied: false,
      status: plan.status,
      plan: publicPlan(plan),
      error: plan.error,
      rollback
    };
  }

  plan.status = 'applied';
  plan.operationIds = operationIds;
  plan.appliedAt = now();
  plan.error = null;
  planStore.write(plan);
  return {
    applied: true,
    status: 'applied',
    files: operationIds.length,
    plan: publicPlan(plan)
  };
}

async function rollbackPropertiesBatch(plugin, operationStore, planStore, args = {}) {
  const plan = planStore.read(args.planId);
  if (plan.kind !== 'properties_batch') throw new Error(`Unsupported plan kind: ${plan.kind}`);
  if (!Array.isArray(plan.operationIds) || !plan.operationIds.length) throw new Error('Plan has no applied operations to roll back');
  if (plan.rolledBackAt) {
    return { rolledBack: true, alreadyRolledBack: true, status: 'rolled_back', plan: publicPlan(plan), failures: [] };
  }
  const rollback = await rollbackOperationIds(plugin, operationStore, plan.operationIds, args.force === true);
  plan.status = rollback.failures.length ? 'rollback_partial' : 'rolled_back';
  plan.rolledBackAt = rollback.failures.length ? null : now();
  plan.rollback = rollback;
  planStore.write(plan);
  return {
    rolledBack: rollback.failures.length === 0,
    status: plan.status,
    plan: publicPlan(plan),
    operationIds: rollback.rolledBack,
    failures: rollback.failures
  };
}

module.exports = {
  applyPropertiesBatch,
  preflightPlan,
  previewPropertiesBatch,
  rollbackOperationIds,
  rollbackPropertiesBatch
};
