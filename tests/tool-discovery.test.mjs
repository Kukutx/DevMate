import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeToolRegistration,
  searchCatalogEntries,
  toolDiscoveryPlugin,
  toolFamily
} from '../gateway/plugins/tool-discovery.mjs';
import { builtinPlugins } from '../gateway/plugins/builtins.mjs';
import { requiredCapabilityForTool, workspaceScopedTool } from '../gateway/tool-policy.mjs';

test('Tool Discovery is a core descriptive plugin and keeps discovery tools non-workspace read operations', () => {
  assert.equal(toolDiscoveryPlugin.manifest.core, true);
  assert.equal(toolDiscoveryPlugin.manifest.defaultEnabled, true);
  assert.equal(builtinPlugins[0].manifest.id, 'devmate.tool-discovery');
  for (const name of ['devmate_tool_catalog', 'devmate_tool_search']) {
    assert.equal(workspaceScopedTool(name), false, name);
    assert.equal(requiredCapabilityForTool(name, { readOnlyHint: true }), 'read', name);
  }
  const tools = new Map();
  toolDiscoveryPlugin.activate({
    server: { registerTool(name, config, handler) { tools.set(name, { config, handler }); } },
    toolText(payload) { return payload; }
  });
  assert.deepEqual([...tools.keys()], ['devmate_tool_catalog', 'devmate_tool_search']);
});

test('tool discovery assigns stable model-neutral families and policy metadata', () => {
  assert.equal(toolFamily('browser_control_snapshot'), 'browser');
  assert.equal(toolFamily('git_diff'), 'git');
  assert.equal(toolFamily('obsidian_note_query'), 'obsidian');
  assert.equal(toolFamily('run_command'), 'process');
  const tool = describeToolRegistration({
    name: 'git_diff',
    title: 'Git diff',
    description: 'Read the current diff.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    hasInputSchema: true,
    hasOutputSchema: false
  });
  assert.equal(tool.family, 'git');
  assert.equal(tool.capability, 'git');
  assert.equal(tool.workspaceScoped, true);
  assert.equal(tool.ownerOnly, false);
});

test('tool search ranks exact names and supports family/capability filters without hiding the catalog', () => {
  const tools = [
    { name: 'read_file', title: 'Read file', description: 'Read workspace file', family: 'workspace', capability: 'read' },
    { name: 'browser_control_snapshot', title: 'Snapshot browser tab', description: 'Read browser page state and ARIA', family: 'browser', capability: 'admin' },
    { name: 'browser_control_act', title: 'Act in managed browser', description: 'Click, type, and navigate', family: 'browser', capability: 'admin' }
  ];
  assert.equal(searchCatalogEntries(tools, { query: 'browser_control_snapshot' })[0].name, 'browser_control_snapshot');
  assert.deepEqual(searchCatalogEntries(tools, { query: 'browser', family: 'browser' }).map(item => item.name), [
    'browser_control_snapshot',
    'browser_control_act'
  ]);
  assert.deepEqual(searchCatalogEntries(tools, { capability: 'read' }).map(item => item.name), ['read_file']);
});
