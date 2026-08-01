const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,199}$/;
const CAPABILITIES = Object.freeze(['read', 'validate', 'write', 'execute', 'git', 'publish', 'admin']);

const ADMIN_TOOLS = new Set([
  'team_configure', 'team_member_list', 'team_member_create', 'team_member_update', 'team_member_rotate', 'team_member_revoke', 'team_activity_status',
  'read_audit_log', 'list_backups', 'task_status', 'task_report', 'start_task', 'finish_task', 'rollback_task', 'local_capabilities_status', 'list_trusted_roots',
  'plugin_enable', 'plugin_disable', 'plugin_configure', 'configure_local_capabilities', 'published_preview_list',
  'add_trusted_root', 'remove_trusted_root',
  'job_runtime_configure', 'deployment_drain_start', 'deployment_drain_cancel',
  'runner_control_configure', 'runner_credential_list', 'runner_credential_create', 'runner_credential_update', 'runner_credential_rotate', 'runner_credential_revoke'
]);

const OWNER_ONLY_TOOLS = new Set([
  'team_configure', 'team_member_list', 'team_member_create', 'team_member_update', 'team_member_rotate', 'team_member_revoke',
  'runner_control_configure', 'runner_credential_list', 'runner_credential_create', 'runner_credential_update', 'runner_credential_rotate', 'runner_credential_revoke'
]);

const PUBLISH_TOOLS = new Set([
  'git_push', 'git_pull', 'deployment_publish', 'deployment_rotate_credentials',
  'published_preview_share', 'published_preview_revoke'
]);

const VALIDATE_TOOLS = new Set([
  'run_smart_checks', 'job_submit', 'job_retry',
  'browser_qa_run', 'browser_qa_run_saved', 'web_preview_start', 'web_preview_stop',
  'godot_doctor', 'godot_validate', 'godot_export', 'godot_export_matrix', 'godot_export_web',
  'godot_native_test', 'godot_acceptance_test', 'godot_acceptance_run_saved', 'godot_acceptance_suite',
  'godot_quality_report', 'godot_performance_test', 'godot_performance_regression', 'godot_movie_capture',
  'godot_test_run', 'godot_advanced_run_saved', 'godot_advanced_suite', 'godot_release_gate'
]);

const EXECUTE_TOOLS = new Set([
  'run_command', 'start_process', 'send_process_input', 'stop_process', 'godot_run'
]);

const WRITE_TOOLS = new Set([
  'write_file', 'create_file', 'apply_patch', 'delete_file', 'move_file', 'restore_backup',
  'godot_qa_bridge_install', 'godot_qa_bridge_remove', 'godot_quick_setup',
  'godot_performance_baseline_update', 'godot_automation_bootstrap', 'job_cancel'
]);

const NON_WORKSPACE_TOOLS = new Set([
  'gateway_status', 'gateway_self_test', 'maintenance_status', 'connection_diagnostics',
  'devmate_status_panel', 'devmate_team_panel', 'list_workspaces',
  'plugin_catalog', 'plugin_diagnostics', 'plugin_enable', 'plugin_disable', 'plugin_configure', 'devmate_plugins_panel',
  'team_status', 'team_member_list', 'team_member_create', 'team_member_update', 'team_member_rotate', 'team_member_revoke',
  'team_activity_status', 'team_configure', 'deployment_status', 'deployment_readiness', 'deployment_policy_template',
  'workspace_lease_status', 'published_preview_share', 'published_preview_list', 'published_preview_revoke',
  'job_target_catalog', 'job_runtime_configure', 'job_submit', 'job_list', 'job_status', 'job_artifacts', 'job_cancel', 'job_retry', 'runner_status',
  'deployment_drain_status', 'deployment_drain_start', 'deployment_drain_cancel',
  'runner_control_status', 'runner_control_configure', 'runner_credential_list', 'runner_credential_create',
  'runner_credential_update', 'runner_credential_rotate', 'runner_credential_revoke'
]);

function jobPolicy(requiredCapabilities, pluginId = null) {
  return Object.freeze({
    requiredCapabilities: Object.freeze([...new Set(requiredCapabilities)]),
    pluginId
  });
}

const JOB_TARGET_POLICIES = Object.freeze({
  project_snapshot: jobPolicy(['core']),
  show_changes: jobPolicy(['core']),
  task_report: jobPolicy(['core']),
  run_smart_checks: jobPolicy(['core']),
  run_project_script: jobPolicy(['core']),
  run_configured_command: jobPolicy(['core']),
  browser_qa_run: jobPolicy(['core', 'browser-qa'], 'devmate.browser-qa'),
  browser_qa_run_saved: jobPolicy(['core', 'browser-qa'], 'devmate.browser-qa'),
  godot_project_audit: jobPolicy(['core', 'godot'], 'devmate.godot'),
  godot_validate: jobPolicy(['core', 'godot'], 'devmate.godot'),
  godot_export: jobPolicy(['core', 'godot'], 'devmate.godot'),
  godot_export_matrix: jobPolicy(['core', 'godot'], 'devmate.godot'),
  godot_export_web: jobPolicy(['core', 'godot', 'browser-qa'], 'devmate.godot'),
  godot_native_test: jobPolicy(['core', 'godot'], 'devmate.godot'),
  godot_acceptance_test: jobPolicy(['core', 'godot', 'browser-qa'], 'devmate.godot'),
  godot_acceptance_run_saved: jobPolicy(['core', 'godot', 'browser-qa'], 'devmate.godot'),
  godot_acceptance_suite: jobPolicy(['core', 'godot', 'browser-qa'], 'devmate.godot'),
  godot_quality_report: jobPolicy(['core', 'godot'], 'devmate.godot'),
  godot_performance_test: jobPolicy(['core', 'godot'], 'devmate.godot'),
  godot_performance_regression: jobPolicy(['core', 'godot'], 'devmate.godot'),
  godot_movie_capture: jobPolicy(['core', 'godot'], 'devmate.godot'),
  godot_test_run: jobPolicy(['core', 'godot'], 'devmate.godot'),
  godot_advanced_run_saved: jobPolicy(['core', 'godot'], 'devmate.godot'),
  godot_advanced_suite: jobPolicy(['core', 'godot'], 'devmate.godot'),
  godot_release_gate: jobPolicy(['core', 'godot'], 'devmate.godot'),
  git_save: jobPolicy(['core'])
});

export function ownerOnlyTool(name) {
  return OWNER_ONLY_TOOLS.has(String(name || ''));
}

export function requiredCapabilityForTool(name, annotations = {}, args = {}) {
  const tool = String(name || '');
  if (OWNER_ONLY_TOOLS.has(tool) || ADMIN_TOOLS.has(tool)) return 'admin';
  if (tool === 'git_save' && args?.push) return 'publish';
  if (tool === 'git_raw') {
    const first = String(args?.args?.[0] || '').toLowerCase();
    return ['push', 'pull', 'fetch', 'remote'].includes(first) ? 'publish' : 'git';
  }
  if (PUBLISH_TOOLS.has(tool)) return 'publish';
  if (tool.startsWith('git_')) return 'git';
  if (VALIDATE_TOOLS.has(tool) || tool.startsWith('automation_')) return 'validate';
  if (EXECUTE_TOOLS.has(tool)) return 'execute';
  if (WRITE_TOOLS.has(tool)) return 'write';
  if (annotations?.readOnlyHint === true) return 'read';
  if (annotations?.destructiveHint === true) return 'write';
  return 'read';
}

export function toolWorkspaceId(name, args = {}, config = {}) {
  const tool = String(name || '');
  if (
    NON_WORKSPACE_TOOLS.has(tool) ||
    tool.startsWith('team_') ||
    tool.startsWith('deployment_') ||
    tool.startsWith('runner_')
  ) return null;
  const explicit = String(args?.workspaceId || '').trim();
  if (explicit) return config.workspaces?.find(item => item.id === explicit || item.name === explicit)?.id || explicit;
  return config.activeWorkspaceId || null;
}

export function jobTargetPolicy(name, config = {}) {
  const tool = String(name || '');
  const policy = JOB_TARGET_POLICIES[tool] || null;
  if (!policy) return null;
  if (tool === 'git_save' && config?.allowJobGitSave === false) return null;
  return policy;
}

export function jobTargetNames(config = {}) {
  return Object.keys(JOB_TARGET_POLICIES).filter(name => !!jobTargetPolicy(name, config)).sort();
}

export function validateToolRegistration(name, config = {}) {
  const errors = [];
  const warnings = [];
  const tool = String(name || '').trim();
  if (!TOOL_NAME_PATTERN.test(tool)) errors.push(`Invalid MCP tool name: ${tool || '(empty)'}`);
  if (!String(config?.title || '').trim()) errors.push(`Tool ${tool || '(empty)'} is missing title`);
  if (!String(config?.description || '').trim()) errors.push(`Tool ${tool || '(empty)'} is missing description`);
  if (!config || !Object.hasOwn(config, 'inputSchema')) errors.push(`Tool ${tool || '(empty)'} is missing inputSchema`);
  const annotations = config?.annotations;
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) {
    errors.push(`Tool ${tool || '(empty)'} is missing annotations`);
  } else {
    for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      if (typeof annotations[key] !== 'boolean') errors.push(`Tool ${tool || '(empty)'} annotation ${key} must be boolean`);
    }
    if (annotations.readOnlyHint === true && annotations.destructiveHint === true) {
      errors.push(`Tool ${tool || '(empty)'} cannot be both read-only and destructive`);
    }
    if (annotations.readOnlyHint === true && requiredCapabilityForTool(tool, annotations) !== 'read') {
      warnings.push(`Tool ${tool} is annotated read-only but policy requires ${requiredCapabilityForTool(tool, annotations)}`);
    }
  }
  return {
    name: tool,
    capability: requiredCapabilityForTool(tool, annotations || {}),
    workspaceScoped: !NON_WORKSPACE_TOOLS.has(tool) && !tool.startsWith('team_') && !tool.startsWith('deployment_') && !tool.startsWith('runner_'),
    ownerOnly: ownerOnlyTool(tool),
    job: jobTargetPolicy(tool) ? {
      requiredCapabilities: [...jobTargetPolicy(tool).requiredCapabilities],
      pluginId: jobTargetPolicy(tool).pluginId
    } : null,
    errors,
    warnings,
    ok: errors.length === 0
  };
}

export function toolPolicyCatalog() {
  return {
    capabilities: [...CAPABILITIES],
    ownerOnlyTools: [...OWNER_ONLY_TOOLS].sort(),
    nonWorkspaceTools: [...NON_WORKSPACE_TOOLS].sort(),
    jobTargets: jobTargetNames().map(name => ({ name, ...JOB_TARGET_POLICIES[name], requiredCapabilities: [...JOB_TARGET_POLICIES[name].requiredCapabilities] }))
  };
}

export const __test = {
  ADMIN_TOOLS,
  EXECUTE_TOOLS,
  JOB_TARGET_POLICIES,
  NON_WORKSPACE_TOOLS,
  OWNER_ONLY_TOOLS,
  PUBLISH_TOOLS,
  TOOL_NAME_PATTERN,
  VALIDATE_TOOLS,
  WRITE_TOOLS
};
