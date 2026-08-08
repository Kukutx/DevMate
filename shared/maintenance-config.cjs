'use strict';

const DEFAULT_MAINTENANCE = Object.freeze({
  backupRetentionDays: 30,
  auditRetentionDays: 30,
  maxBackupBytes: 256 * 1024 * 1024,
  maxAuditBytes: 5 * 1024 * 1024
});

const MAINTENANCE_LIMITS = Object.freeze({
  backupRetentionDays: Object.freeze([1, 3650]),
  auditRetentionDays: Object.freeze([1, 3650]),
  maxBackupBytes: Object.freeze([1024 * 1024, 10 * 1024 * 1024 * 1024]),
  maxAuditBytes: Object.freeze([256 * 1024, 100 * 1024 * 1024])
});

module.exports = {
  DEFAULT_MAINTENANCE,
  MAINTENANCE_LIMITS
};
