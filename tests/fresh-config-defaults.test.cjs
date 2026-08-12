'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { newInstanceConfig } = require('../shared/config-store.cjs');

test('fresh DevMate config keeps background jobs opt-in and uses canonical host context state', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-fresh-config-'));
  try {
    const config = newInstanceConfig({ workspaceRoot });
    assert.equal(config.jobs.embeddedRunnerEnabled, false);
    assert.deepEqual(config.hostContexts, {});
    assert.equal(config.activeHostId, null);
    assert.equal(Object.hasOwn(config, 'vscodeContext'), false);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
