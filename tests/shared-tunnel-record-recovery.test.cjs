'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  RUNTIME_RECORD_VERSION,
  SharedTunnelRecordStore
} = require('../vscode-host/shared-tunnel-record-store.js');

function storeFixture() {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-tunnel-record-recovery-'));
  const store = new SharedTunnelRecordStore({ stateDirectory });
  return { stateDirectory, store };
}

function writePending(store, ownerId = 'owner-a') {
  return store.write(ownerId, {
    hostId: 'vscode-test',
    port: 8787,
    provider: 'ngrok',
    configurationKey: 'a'.repeat(64),
    status: 'pending',
    publicUrl: ''
  });
}

test('recovers tunnel ownership after an interrupted Windows-style replacement', () => {
  const { stateDirectory, store } = storeFixture();
  try {
    writePending(store);
    const replacement = `${store.recordFile}.replace-crash-test`;
    fs.renameSync(store.recordFile, replacement);
    assert.equal(fs.existsSync(store.recordFile), false);

    const recovered = store.read({ includeStale: true });
    assert.equal(recovered.ownerId, 'owner-a');
    assert.equal(fs.existsSync(store.recordFile), true);
    assert.equal(fs.existsSync(replacement), false);
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('preserves a future-version interrupted tunnel replacement and fails closed', () => {
  const { stateDirectory, store } = storeFixture();
  try {
    const replacement = `${store.recordFile}.replace-future-test`;
    fs.writeFileSync(replacement, `${JSON.stringify({
      version: RUNTIME_RECORD_VERSION + 1,
      ownerId: 'future-owner'
    })}\n`, 'utf8');

    assert.throws(
      () => store.read({ includeStale: true }),
      error => error?.code === 'DEVMATE_TUNNEL_RECORD_FUTURE_VERSION'
    );
    assert.equal(fs.existsSync(replacement), true);
    assert.equal(fs.existsSync(store.recordFile), false);
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});
