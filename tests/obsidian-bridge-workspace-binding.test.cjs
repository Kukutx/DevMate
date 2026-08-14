'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { workspaceForRoot } = require('../shared/config-store.cjs');

test('Obsidian bridge binds its vault root instead of the unrelated active workspace', () => {
  const projectRoot = process.cwd();
  const vaultRoot = path.join(projectRoot, 'obsidian-plugin');
  const config = {
    activeWorkspaceId: 'devmate',
    workspaces: [
      { id: 'devmate', root: projectRoot, reference: false },
      { id: 'obsidian-vault', root: vaultRoot, reference: false }
    ]
  };

  assert.equal(
    workspaceForRoot(config, vaultRoot).id,
    'obsidian-vault'
  );
});
