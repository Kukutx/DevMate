'use strict';

const { propertyEquals } = require('./vault-index-core.js');

function serializedSelector(selector) {
  return {
    folder: selector.folder,
    paths: selector.paths,
    tagsAll: selector.tagsAll,
    tagsAny: selector.tagsAny,
    propertyExists: selector.propertyExists,
    propertyMissing: selector.propertyMissing,
    properties: selector.properties,
    search: selector.search,
    modifiedAfter: Number.isFinite(selector.modifiedAfter) ? new Date(selector.modifiedAfter).toISOString() : null,
    modifiedBefore: Number.isFinite(selector.modifiedBefore) ? new Date(selector.modifiedBefore).toISOString() : null
  };
}

function propertyPreview(properties, change) {
  const before = {};
  const after = {};
  let changed = false;
  for (const [key, value] of Object.entries(change.set)) {
    before[key] = properties[key];
    after[key] = value;
    if (!propertyEquals(properties[key], value)) changed = true;
  }
  for (const key of change.remove) {
    before[key] = properties[key];
    after[key] = undefined;
    if (properties[key] !== undefined) changed = true;
  }
  return { changed, before, after };
}

function assertPlanReady(plan, nowMs = Date.now()) {
  if (plan.kind !== 'properties_batch') throw new Error(`Unsupported plan kind: ${plan.kind}`);
  if (!['ready', 'conflict'].includes(plan.status)) throw new Error(`Plan cannot be applied from status ${plan.status}`);
  if (Date.parse(plan.expiresAt || 0) <= nowMs) throw new Error(`Plan expired at ${plan.expiresAt}`);
}

module.exports = {
  assertPlanReady,
  propertyPreview,
  serializedSelector
};
