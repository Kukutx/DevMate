import fs from 'node:fs';
import os from 'node:os';
import { publicMcpUrl } from '../config.mjs';
import { findOnPath, installHint, resolveTool } from '../platform/tools.mjs';
import { VERSION } from '../version.mjs';
import { within } from './shared.mjs';

/**
 * One list of everything that decides whether this installation works, each
 * with the concrete next step. Nothing here starts a model request.
 */
export async function doctor(service) {
  const checks = [];
  const check = (id, status, detail, fix) => checks.push({ id, status, detail, ...(fix ? { fix } : {}) });
  const major = Number(process.versions.node.split('.')[0]);
  check('node', major >= 24 ? 'ok' : 'fail', 'Node.js ' + process.versions.node, major >= 24 ? null : 'Install Node.js 24 or newer.');
  const shell = service.processes.shell;
  check('shell', fs.statSync(shell.file, { throwIfNoEntry: false })?.isFile() ? 'ok' : 'fail', shell.label + ' at ' + shell.file, 'Commands cannot run without the system shell.');
  // Models write `a && b` by habit. Windows PowerShell 5.1 does not have it; PowerShell 7 does.
  if (shell.label === 'Windows PowerShell 5.1') check('shell.version', 'info', 'Commands run in Windows PowerShell 5.1, which has no && and ||.',
    'Install PowerShell 7 (winget install Microsoft.PowerShell) and restart DevMate: it is used automatically and accepts what models usually write.');
  for (const [tool, purpose] of [['rg', 'file find and search'], ['git', 'Git tools']]) {
    let found = null, problem = null;
    try { found = resolveTool(tool); } catch (error) { if (error.code === 'tool_outdated') problem = error.message; }
    if (problem) check(tool, 'fail', problem, 'The ' + purpose + ' do not work until it is updated.');
    else check(tool, found ? 'ok' : 'fail', found ? found + (findOnPath(tool) ? '' : ' (the copy that ships with your editor)') : tool + ' is not on PATH; it is required for ' + purpose, found ? null : installHint(tool));
  }
  // File modes mean nothing on Windows: there, privacy of the instance comes from living in the owner's own profile.
  if (process.platform === 'win32' && !within(os.homedir(), service.instanceRoot)) check('instance', 'warn', 'The instance directory ' + service.instanceRoot + ' is outside your user profile.',
    'Other accounts on this computer may be able to read its owner token and credentials. Keep the instance under ' + os.homedir() + ', or restrict the folder\'s permissions.');
  const projects = service.store.count('project');
  check('projects', projects ? 'ok' : 'warn', projects + ' project(s) registered', projects ? null : 'Register one with devmate project add, or share a folder from an editor that runs DevMate.');
  const windows = service.windows.list().length;
  check('editor', windows ? 'ok' : 'info', windows + ' editor window(s) attached', windows ? null : 'Editor context needs VS Code or Obsidian with DevMate running; diagnostics come from VS Code.');
  for (const provider of (await service.discoverProviders()).items) {
    const installed = provider.status === 'installed', absent = provider.error?.code === 'agent_not_installed';
    // Not installed is a choice; installed but unusable (too old, broken) is something to fix.
    check('agent.' + provider.id, installed ? 'ok' : absent ? 'info' : 'warn',
      installed ? 'installed' + (provider.version ? ', version ' + provider.version : '') : absent ? 'not installed' : provider.error?.message || provider.status,
      installed ? null : absent ? 'Only needed to delegate tasks to ' + provider.id + '.' : 'Update or reinstall ' + provider.id + (provider.minimumVersion ? ' (version ' + provider.minimumVersion + ' or newer)' : '') + ' to delegate tasks to it.');
  }
  const connection = service.config.connection, url = publicMcpUrl(service.config), env = service.secrets.environment();
  const status = await service.connectionState();
  const credential = connection.kind === 'cloudflare' ? connection.tokenEnv : connection.kind === 'openai-tunnel' ? connection.runtimeKeyEnv : null;
  if (connection.kind === 'local') check('connection', 'info', 'Local only: http://127.0.0.1 clients can connect, cloud clients such as ChatGPT cannot.', 'Configure an openai-tunnel or cloudflare connection to use ChatGPT or Claude.ai.');
  else {
    if (connection.executable) check('connection.executable', fs.statSync(connection.executable, { throwIfNoEntry: false })?.isFile() ? 'ok' : 'fail', connection.executable, 'Install the connector and set its absolute path in the connection settings.');
    if (credential) check('connection.credential', env[credential] ? 'ok' : 'fail', credential + (env[credential] ? ' is set' : ' is missing'),
      'Store it with: devmate secret set ' + credential + ' (or "Configure Connection" in the editor), then restart DevMate.');
    const phase = status.phase || status.status || 'unknown', fault = status.error?.message || service.connectionFault?.message;
    check('connection.process', ['connected', 'relay-ready', 'configured', 'process-running'].includes(phase) ? 'ok' : ['connecting', 'starting'].includes(phase) ? 'warn' : 'fail',
      connection.kind + ': ' + phase + (fault ? ' — ' + fault : ''), status.diagnostic ? String(status.diagnostic).slice(-400) : fault ? 'Fix the cause, then restart DevMate (devmate restart, or "Restart" in the editor).' : null);
    if (url) {
      const verification = service.verification?.url === url ? service.verification : await service.verifyConnection();
      check('connection.public', verification.verified ? 'ok' : verification.reachable ? 'warn' : 'fail',
        url + (verification.verified ? ' reaches this runtime' : ' — ' + verification.reason),
        verification.verified ? null : connection.kind === 'cloudflare' ? 'In the Cloudflare dashboard, route the hostname to ' + (status.routeService || 'the ingress port') + '.' : 'Check the proxy route to the ingress port.');
    } else check('connection.public', 'info', 'An OpenAI tunnel cannot be probed from here.', 'Call any DevMate tool from ChatGPT to confirm it.');
  }
  if (url && service.config.auth.mode === 'none') check('security', 'warn', 'The public URL has no sign-in: anyone who learns it can read and change your projects and run commands.',
    'Require sign-in (auth mode oauth, issuer ' + new URL(url).origin + '): add --auth oauth to devmate connect, or use "Configure Connection" in the editor. Each client then signs in once with a code from devmate login-code.');
  else check('security', 'ok', service.config.auth.mode === 'oauth' ? 'OAuth sign-in is required on the public route.' : 'No public URL is exposed.');
  const database = service.store.metrics();
  check('storage', database.databaseBytes > 1024 ** 3 ? 'warn' : 'ok', Math.round(database.databaseBytes / 1048576) + ' MiB state, ' + database.events + ' journal events, ' + service.config.retentionDays + '-day retention',
    database.databaseBytes > 1024 ** 3 ? 'Lower retentionDays in the settings.' : null);
  const worst = ['fail', 'warn'].find(level => checks.some(item => item.status === level)) || 'ok';
  return { status: worst, version: VERSION, instance: service.identity, checks };
}
