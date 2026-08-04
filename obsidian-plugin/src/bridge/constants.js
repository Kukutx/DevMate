'use strict';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_ITEMS = 500;
const MAX_OPERATION_RECORDS = 500;
const MAX_PLAN_RECORDS = 200;
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
const MAX_BATCH_FILES = 200;
const PLAN_TTL_MS = 30 * 60 * 1000;
const BRIDGE_PROTOCOL_VERSION = 2;

const BRIDGE_CAPABILITIES = Object.freeze([
  'status',
  'query_notes',
  'schema_audit',
  'audit_vault',
  'create_note',
  'update_properties',
  'move_note',
  'trash_note',
  'properties_batch_preview',
  'properties_batch_apply',
  'properties_batch_rollback',
  'properties_batch_list',
  'operation_list',
  'operation_rollback'
]);

module.exports = {
  BRIDGE_CAPABILITIES,
  BRIDGE_PROTOCOL_VERSION,
  MAX_BACKUP_BYTES,
  MAX_BATCH_FILES,
  MAX_BODY_BYTES,
  MAX_OPERATION_RECORDS,
  MAX_PLAN_RECORDS,
  MAX_RESPONSE_ITEMS,
  PLAN_TTL_MS
};
