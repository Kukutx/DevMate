import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  jobTargetNames,
  jobTargetPolicy,
  ownerOnlyTool,
  requiredCapabilityForTool,
  toolWorkspaceId,
  validateToolRegistration
} from '../gateway/tool-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(full, output);
    else if (entry.isFile() && /\.mjs$/i.test(entry.name)) output.push(full);
  }
  return output;
}

function literalRegisteredTools() {
  const names = new Set();
  const pattern = /(?:registerTool|register)\(\s*['"]([a-z][a-z0-9_]*)['"]/g;
  for (const file of sourceFiles(path.join(root, 'gateway'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

test('classifies mature Godot tools by actual side effect', () => {
  assert.equal(requiredCapabilityForTool('godot_dependency_graph', { readOnlyHint: true }), 'read');
  assert.equal(requiredCapabilityForTool('godot_quality_report', { destructiveHint: true }), 'validate');
  assert.equal(requiredCapabilityForTool('godot_performance_regression', { destructiveHint: true }), 'validate');
  assert.equal(requiredCapabilityForTool('godot_release_gate', { destructiveHint: true }), 'validate');
  assert.equal(requiredCapabilityForTool('godot_quick_setup', { destructiveHint: true }), 'write');
  assert.equal(requiredCapabilityForTool('godot_performance_baseline_update', { destructiveHint: true }), 'write');
  assert.equal(requiredCapabilityForTool('godot_automation_bootstrap', { destructiveHint: true }), 'write');
  assert.equal(requiredCapabilityForTool('obsidian_properties_batch_preview', { destructiveHint: false }), 'validate');
  assert.equal(requiredCapabilityForTool('obsidian_properties_batch_apply', { destructiveHint: true }), 'write');
});

test('fails closed when a new tool has no explicit capability or side-effect annotation', () => {
  assert.equal(requiredCapabilityForTool('future_tool', {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  }), 'admin');
  const registration = validateToolRegistration('future_tool', {
    title: 'Future tool',
    description: 'An intentionally unclassified tool.',
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  });
  assert.equal(registration.ok, false);
  assert.match(registration.errors.join('\n'), /no explicit capability policy/);
});

test('classifies every workspace-controlled command entry as execute', () => {
  for (const name of [
    'run_command',
    'run_configured_command',
    'run_project_script',
    'run_smart_checks',
    'start_process'
  ]) {
    assert.equal(requiredCapabilityForTool(name, { destructiveHint: true }), 'execute', name);
  }
});

test('reserves global audit and backup recovery surfaces for owners', () => {
  for (const name of ['read_audit_log', 'list_backups', 'restore_backup']) {
    assert.equal(ownerOnlyTool(name), true, name);
  }
  assert.equal(ownerOnlyTool('write_file'), false);
});

test('routes Web Godot jobs to Browser QA capable runners', () => {
  for (const name of [
    'godot_export_web',
    'godot_acceptance_test',
    'godot_acceptance_run_saved',
    'godot_acceptance_suite'
  ]) {
    const policy = jobTargetPolicy(name);
    assert.ok(policy, name);
    assert.equal(policy.pluginId, 'devmate.godot');
    assert.equal(policy.requiredCapabilities.includes('browser-qa'), true, name);
  }
  assert.deepEqual(jobTargetPolicy('godot_native_test').requiredCapabilities, ['core', 'godot']);
});

test('durable job policies reference literal registered tools', () => {
  const registered = literalRegisteredTools();
  const missing = jobTargetNames().filter(name => !registered.has(name));
  assert.deepEqual(missing, []);
});

test('validates complete tool registration contracts', () => {
  const valid = validateToolRegistration('example_read', {
    title: 'Example read',
    description: 'Read an example.',
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.capability, 'read');

  const invalid = validateToolRegistration('bad tool', {
    title: '',
    inputSchema: {}
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors.length >= 3, true);
});

test('keeps queue administration global while project tools remain scoped', () => {
  const config = {
    activeWorkspaceId: 'app',
    workspaces: [{ id: 'app', name: 'Application' }]
  };
  assert.equal(toolWorkspaceId('job_submit', { workspaceId: 'app' }, config), null);
  assert.equal(toolWorkspaceId('runner_status', {}, config), null);
  assert.equal(toolWorkspaceId('godot_release_gate', {}, config), 'app');
  assert.equal(toolWorkspaceId('read_file', { workspaceId: 'Application' }, config), 'app');
});