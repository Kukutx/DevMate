#!/usr/bin/env python3
from pathlib import Path
import re
import textwrap

root = Path(__file__).resolve().parents[1]


def read(name):
    return (root / name).read_text(encoding='utf-8')


def write(name, value):
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value.rstrip() + '\n', encoding='utf-8')


# All workspace resolution, including trusted roots and team/Runner scopes,
# uses the same exact-ID-first resolver.
shared = read('gateway/local-shared.mjs')
import_marker = "import configStore from '../shared/config-store.cjs';"
if import_marker not in shared:
    raise RuntimeError('Could not locate shared config-store import')
shared = shared.replace(
    import_marker,
    import_marker + "\nimport { resolveWorkspace } from './workspace-resolver.mjs';",
    1
)

old_writable = """export function getWritableWorkspace(config, id) {
  const workspace = id
    ? config.workspaces?.find(item => item.id === id || item.name === id)
    : activeWorkspace(config);
  if (!workspace) throw new Error('No workspace configured');
  if (workspace.reference || workspace.mode === 'readonly') throw new Error(`Workspace is readonly/reference: ${workspace.id}`);
  return workspace;
}"""
new_writable = """export function getWritableWorkspace(config, id) {
  const workspace = id ? resolveWorkspace(config, id) : activeWorkspace(config);
  if (!workspace) throw new Error('No workspace configured');
  if (workspace.reference || workspace.mode === 'readonly') throw new Error(`Workspace is readonly/reference: ${workspace.id}`);
  return workspace;
}"""
if old_writable not in shared:
    raise RuntimeError('Could not replace writable workspace resolution')
shared = shared.replace(old_writable, new_writable, 1)

# Audit metadata remains system-owned, while callers may explicitly pass a
# trusted task ID after the task has been removed from config.
shared = shared.replace(
    'export async function audit(action, payload = {}) {',
    'export async function audit(action, payload = {}, options = {}) {',
    1
)
shared = shared.replace(
    'taskId: config.task?.currentTaskId || null,',
    'taskId: options.taskId ?? config.task?.currentTaskId ?? null,',
    1
)

# Remove stale test exports that referred to the deleted duplicate persistence implementation.
shared, count = re.subn(
    r"export const __test = \{.*?\n\};",
    "export const __test = { boundedAuditLine };",
    shared,
    count=1,
    flags=re.S,
)
if count != 1:
    raise RuntimeError('Could not replace stale local-shared test exports')
write('gateway/local-shared.mjs', shared)

server = read('gateway/server.mjs')
old_audit_wrapper = 'async function audit(action,payload){ return shared.audit(action,payload); }'
new_audit_wrapper = 'async function audit(action,payload,options){ return shared.audit(action,payload,options); }'
if old_audit_wrapper not in server:
    raise RuntimeError('Could not update Gateway audit wrapper')
server = server.replace(old_audit_wrapper, new_audit_wrapper, 1)
old_finish_audit = "if(finished) await audit('finish_task',{taskId:finished.currentTaskId,title:finished.title,startedAt:finished.startedAt,finishedAt:finished.finishedAt});"
new_finish_audit = "if(finished) await audit('finish_task',{title:finished.title,startedAt:finished.startedAt,finishedAt:finished.finishedAt},{taskId:finished.currentTaskId});"
if old_finish_audit not in server:
    raise RuntimeError('Could not preserve finished task audit identity')
server = server.replace(old_finish_audit, new_finish_audit, 1)
write('gateway/server.mjs', server)

# Every tool that executes workspace-controlled shell/package commands requires execute.
policy = read('gateway/tool-policy.mjs')
policy = policy.replace(
    "  'run_smart_checks', 'job_submit', 'job_retry', 'obsidian_properties_batch_preview',",
    "  'job_submit', 'job_retry', 'obsidian_properties_batch_preview',",
    1
)
policy = policy.replace(
    "  'run_command', 'run_configured_command', 'run_project_script', 'start_process',",
    "  'run_command', 'run_configured_command', 'run_project_script', 'run_smart_checks', 'start_process',",
    1
)
write('gateway/tool-policy.mjs', policy)

# Team and Runner scopes resolve through the same strict identity function.
team_data = read('gateway/team-tool-data.mjs')
team_data = team_data.replace(
    "import { listWorkspaceLeases } from './workspace-leases.mjs';",
    "import { listWorkspaceLeases } from './workspace-leases.mjs';\nimport { resolveWorkspaceId } from './workspace-resolver.mjs';",
    1
)
team_data, count = re.subn(
    r"export function workspaceIds\(config, values = \[\]\) \{.*?\n\}",
    textwrap.dedent(
        """
        export function workspaceIds(config, values = []) {
          return [...new Set(
            values
              .map(value => String(value || '').trim())
              .filter(Boolean)
              .map(value => resolveWorkspaceId(config, value))
          )];
        }
        """
    ).strip(),
    team_data,
    count=1,
    flags=re.S,
)
if count != 1:
    raise RuntimeError('Could not replace team and Runner scope resolution')
write('gateway/team-tool-data.mjs', team_data)

# Policy and scope regressions.
policy_test = read('tests/tool-policy.test.mjs')
insert_before = "test('routes Web Godot jobs to Browser QA capable runners', () => {"
new_test = textwrap.dedent(
    """
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

    """
)
if insert_before not in policy_test:
    raise RuntimeError('Could not insert dynamic command policy test')
policy_test = policy_test.replace(insert_before, new_test + insert_before, 1)
write('tests/tool-policy.test.mjs', policy_test)

write(
    'tests/workspace-scope-resolution.test.mjs',
    textwrap.dedent(
        """
        import assert from 'node:assert/strict';
        import test from 'node:test';
        import { workspaceIds } from '../gateway/team-tool-data.mjs';

        test('team and Runner scopes prefer exact workspace IDs', () => {
          const config = {
            workspaces: [
              { id: 'active', name: 'reference', reference: false },
              { id: 'reference', name: 'active', reference: true, mode: 'readonly' }
            ]
          };
          assert.deepEqual(workspaceIds(config, ['reference']), ['reference']);
          assert.deepEqual(workspaceIds(config, ['active']), ['active']);
        });

        test('team and Runner scopes reject ambiguous display names', () => {
          const config = {
            workspaces: [
              { id: 'one', name: 'same' },
              { id: 'two', name: 'same', reference: true }
            ]
          };
          assert.throws(() => workspaceIds(config, ['same']), error => {
            assert.equal(error.code, 'workspace_ambiguous');
            return true;
          });
        });
        """
    )
)

persistence_test = read('tests/config-persistence.test.mjs')
insert_before = "test('rejects malformed configuration roots with the config path in the error', async t => {"
audit_test = textwrap.dedent(
    """
    test('accepts an explicit trusted task ID after task state is cleared', async t => {
      const { directory, shared } = await withConfig(t, 'devmate-config-finished-task-', {
        version: 1,
        permissions: { profile: 'fullAccess' }
      });
      await shared.audit('finish_task', { taskId: 'forged', title: 'done' }, { taskId: 'task-real' });
      const auditPath = path.join(directory, 'state', 'audit.jsonl');
      const entry = JSON.parse((await fsp.readFile(auditPath, 'utf8')).trim());
      assert.equal(entry.taskId, 'task-real');
      assert.equal(entry.action, 'finish_task');
      assert.equal(entry.title, 'done');
    });

    """
)
if insert_before not in persistence_test:
    raise RuntimeError('Could not insert finished task audit test')
persistence_test = persistence_test.replace(insert_before, audit_test + insert_before, 1)
write('tests/config-persistence.test.mjs', persistence_test)

# Keep architectural constraints executable.
checker = read('scripts/check-repository.mjs')
needle = "['extension-entry-platform.js', /extension-config-io|extension-entry-win32/, 'removed compatibility entry']"
replacement = needle + ",\n  ['gateway/team-tool-data.mjs', /map\\.set\\(item\\.name/, 'ambiguous workspace scope map']"
if needle not in checker:
    raise RuntimeError('Could not extend architecture contracts')
checker = checker.replace(needle, replacement, 1)
write('scripts/check-repository.mjs', checker)

(root / 'scripts/finalize_runtime_integrity.py').unlink()
print('Completed runtime integrity convergence.')
