import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export const WORKBENCH_RESOURCE_URI = 'ui://devmate/workbench/v1';
export const WORKBENCH_MIME = 'text/html;profile=mcp-app';
// Exactly what workbench/app.js calls when it runs inside a host. Operations that are only for the local owner
// interface never belong here. The owner's own decisions (sharing a folder, answering an agent) are listed, and the
// service refuses them from an embedded workbench unless the owner chose full access: until then it shows them
// and the owner acts at their computer.
export const WORKBENCH_OPERATIONS = Object.freeze([
  'workbench.snapshot', 'operations.list', 'connection.status',
  'project.list', 'project.create', 'project.update', 'project.remove', 'project.overview',
  'workflow.create', 'workflow.update',
  'workspace.files', 'workspace.find', 'workspace.search', 'workspace.read', 'workspace.write',
  'workspace.mkdir', 'workspace.move', 'workspace.delete', 'workspace.history', 'workspace.restore',
  'git.status', 'git.diff', 'editor.diagnostics',
  'shell.run', 'process.list', 'process.read', 'process.stop',
  'agents.list', 'agents.start', 'agents.stop', 'agents.resume', 'agents.send', 'agents.steer',
  'agents.cancel', 'agents.delegate', 'agents.result',
  'event.list', 'job.list', 'job.read', 'message.list', 'message.send',
  'task.list', 'task.create', 'task.update',
  'approval.list', 'approval.resolve', 'approval.cancel', 'input.list', 'input.respond',
  'artifact.list', 'artifact.read', 'artifact.create',
  'reference.list', 'reference.add', 'reference.remove'
]);
const icon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33"><rect x="2" y="3" width="16" height="14" rx="3"/><path d="M2 7h16M7 7v10m4-7 2 2-2 2"/></svg>');
const launcherMeta = {
  ui: { resourceUri: WORKBENCH_RESOURCE_URI, visibility: ['model', 'app'] },
  'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] }
};
const selectionSchema = {
  type: 'object', additionalProperties: false,
  properties: { projectId: { type: 'string', minLength: 1 }, workflowId: { type: 'string', minLength: 1 } }
};
export function workbenchToolDescriptors() {
  return [
    {
      name: 'open_devmate_workbench', title: 'DevMate Workbench',
      description: 'Open the full DevMate workspace: projects, workflows, files, Git changes, commands, editor problems, agents and their activity, messages, tasks, approvals, artifacts and references. Opening does not start execution.',
      icons: [{ src: icon, mimeType: 'image/svg+xml' }], inputSchema: selectionSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: launcherMeta
    },
    {
      name: 'workbench_call', title: 'DevMate Workbench operation',
      description: 'App-only operation for the DevMate Workbench. Every operation uses the same authenticated service and project permissions.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['operation'],
        properties: { operation: { type: 'string', enum: WORKBENCH_OPERATIONS }, input: { type: 'object' } } },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ['app'] } }
    }
  ];
}
function fault(message, code) { return Object.assign(new Error(message), { code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export async function callWorkbenchTool(name, args = {}, service, context = {}) {
  if (!object(args)) throw fault('Tool arguments must be an object.', 'invalid_input');
  let result;
  if (name === 'open_devmate_workbench') {
    if (Object.keys(args).some(key => !['projectId', 'workflowId'].includes(key)) ||
        Object.values(args).some(value => typeof value !== 'string' || !value.trim()))
      throw fault('Only explicit projectId and workflowId selectors are accepted.', 'invalid_input');
    // The model sees this result. It needs to know what was opened, not the whole workspace:
    // the app loads its own data through workbench_call.
    const { selection, counts } = await service.snapshot(args, context);
    result = { selection, counts };
  } else if (name === 'workbench_call') {
    if (Object.keys(args).some(key => !['operation', 'input'].includes(key)) ||
        !WORKBENCH_OPERATIONS.includes(args.operation) ||
        (args.input !== undefined && !object(args.input)))
      throw fault('Unknown Workbench operation or invalid input.', 'invalid_input');
    result = await service.call(args.operation, args.input || {}, context);
  } else throw fault('Unknown Workbench tool.', 'tool_not_found');
  return { content: [{ type: 'text', text: name === 'open_devmate_workbench' ? 'DevMate Workbench is ready.' : 'Workbench operation completed.' }], structuredContent: result };
}

// Read once: an editor update removes the folder an already running runtime was started from, and the
// workbench of that runtime must keep opening until it is restarted.
let parts = null;
const workbenchParts = () => parts ||= Promise.all([
  readFile(new URL('../workbench/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../workbench/styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../workbench/bridge.bundle.js', import.meta.url), 'utf8'),
  readFile(new URL('../workbench/app.js', import.meta.url), 'utf8')
]).catch(error => { parts = null; throw error; });
export async function workbenchHtml() {
  const [template, css, bridge, app] = await workbenchParts();
  const nonce = randomBytes(18).toString('base64');
  return template.replaceAll('__DEVMATE_NONCE__', nonce)
    .replace('/* DEVMATE_STYLES */', () => css.replaceAll('</style', '<\\/style'))
    .replace('/* DEVMATE_BRIDGE */', () => bridge.replaceAll('</script', '<\\/script'))
    .replace('/* DEVMATE_APP */', () => app.replaceAll('</script', '<\\/script'));
}
export async function readWorkbenchResource() {
  return { contents: [{
    uri: WORKBENCH_RESOURCE_URI, mimeType: WORKBENCH_MIME, text: await workbenchHtml(),
    _meta: {
      // Only what MCP Apps defines. The app itself asks the host for fullscreen
      // through the SDK (workbench/bridge.js) when the host offers that mode.
      ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false }
    }
  }] };
}
export function registerWorkbench(server, service) {
  const [open, call] = workbenchToolDescriptors();
  // The app tells failures apart by code (a conflict, a refusal that needs a second confirmation),
  // so a failed call keeps its code next to the message instead of becoming plain text.
  const answer = name => async (args, context) => {
    try { return await callWorkbenchTool(name, args, service, context); }
    catch (error) {
      const failure = { code: error.code || 'operation_failed', message: error.message };
      return { isError: true, content: [{ type: 'text', text: failure.message }], structuredContent: { error: failure } };
    }
  };
  server.registerResource('devmate-workbench', WORKBENCH_RESOURCE_URI,
    { title: 'DevMate Workbench', description: 'DevMate project and multi-agent workbench.', mimeType: WORKBENCH_MIME },
    readWorkbenchResource);
  server.registerTool(open.name, {
    ...open, inputSchema: z.object({ projectId: z.string().trim().min(1).optional(), workflowId: z.string().trim().min(1).optional() }).strict()
  }, answer(open.name));
  server.registerTool(call.name, {
    ...call, inputSchema: z.object({ operation: z.enum(WORKBENCH_OPERATIONS), input: z.record(z.string(), z.unknown()).optional() }).strict()
  }, answer(call.name));
}
/** The page itself: static, the same for every caller, with no data in it. Everything it shows is loaded by authenticated calls. */
export async function handleWorkbench(req, res) {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (!['/', '/workbench', '/workbench/'].includes(path)) return false;
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Method not allowed'); return true;
  }
  const html = await workbenchHtml();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(req.method === 'HEAD' ? undefined : html); return true;
}
