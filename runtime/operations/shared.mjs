import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../store.mjs';
import { redactCommand } from '../platform/redact.mjs';

// The input shapes every group of operations builds from. Every text a caller
// can send has an upper bound, so no single request can be arbitrarily large.
export const id = z.string().min(1).max(160);
export const text = z.string().max(100000);
export const fileText = z.string().max(4000000);
/** A path inside a project. */
export const projectPath = z.string().min(1).max(4096);
/** A directory on this computer. */
export const directory = z.string().min(1).max(32768);
export const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const line = z.number().int().min(1);
// How long one call may wait. Clients cut a tool call off (ChatGPT after about a minute, Claude after four) and a
// Cloudflare route gives an answer 100 seconds to begin. What is still running then keeps running and is asked
// about again with process_read or agents_result.
export const waitMs = z.number().int().min(0).max(50000).optional();
// Optional in the schema, always present for the handler: call() fills in the caller's only project.
/** How a caller names a project: its id, its unique name, or its root directory. */
export const projectReference = z.string().min(1).max(32768);
export const projectScope = { projectId: projectReference.optional().describe('Project id, root directory or unique name. May be omitted when exactly one project is available; with several, read-only tools use the project of the editor window used last and every change needs it.') };
export const workflowScope = { ...projectScope, workflowId: id };
export const mutation = { operationId: id.optional() };
export const revision = { expectedRevision: z.number().int().positive().optional() };
export const listOptions = { projectId: projectReference.optional(), workflowId: id.optional(),
  query: z.string().max(200).optional().describe('Keep items whose text contains this.'),
  status: z.string().max(40).optional().describe('Keep items in exactly this status, as the items themselves report it (for example pending, running, completed). An unknown value matches nothing.'),
  newestFirst: z.boolean().optional(),
  cursor: id.optional().describe('nextCursor of the previous page.'), limit: z.number().int().min(1).max(1000).optional() };
// A command is either shell text (PowerShell on Windows, sh elsewhere) or an exact executable launch.
export const commandShape = { command: z.string().min(1).max(100000).optional(), file: z.string().min(1).max(4096).optional(),
  args: z.array(z.string().max(100000)).max(2000).optional(), cwd: z.string().max(4096).optional(),
  timeoutMs: z.number().int().min(1000).max(86400000).optional() };

export const now = () => new Date().toISOString();
export const hash = value => createHash('sha256').update(value).digest('hex');
export const actor = context => ({ id: context.id, kind: 'user', label: context.role === 'owner' ? 'You' : context.id });
export const within = (root, target) => { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
export const oneCommand = value => {
  if ((value.command === undefined) === (value.file === undefined)) throw new DomainError('invalid_command', 'Supply either command text or an executable file with args.');
  if (value.command !== undefined && value.args !== undefined) throw new DomainError('invalid_command', 'args applies only to an executable file.');
  return value;
};

// A job keeps the exact command it runs. The owner and whoever started it see it as it
// is; anyone else who may list the project's jobs sees it without inline credentials.
export function jobFor(job, context) {
  if (!job?.input?.args || context.role === 'owner' || job.input.caller?.id === context.id) return job;
  return { ...job, input: { ...job.input, args: redactCommand(job.input.args) } };
}
export function eventFor(event, context) {
  if (context.role === 'owner' || !event?.entity?.input?.args || event.entity.input.caller?.id === context.id) return event;
  return { ...event, entity: jobFor(event.entity, context) };
}
