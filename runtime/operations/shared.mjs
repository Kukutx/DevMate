import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../store.mjs';

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
// Optional in the schema, always present for the handler: call() fills in the project that is meant.
/** How a caller names a project: its id, its unique name, or its root directory. */
export const projectReference = z.string().min(1).max(32768);
export const projectScope = { projectId: projectReference.optional().describe('Project id, root directory or unique name. Needed only when several projects are shared.') };
export const workflowScope = { ...projectScope, workflowId: id };
export const mutation = { operationId: id.optional() };
// Set on the result of a call that named no project while several were available: the project it was answered
// from, so that whoever presents the result can say so.
export const FOLLOWED_PROJECT = Symbol('the project a call without projectId was answered from');
export const revision = { expectedRevision: z.number().int().positive().optional() };
export const listOptions = { projectId: projectReference.optional(), workflowId: id.optional(),
  query: z.string().max(200).optional().describe('Keep items whose text contains this.'),
  status: z.string().max(40).optional().describe('Keep items in exactly this status, as the items themselves report it (for example pending, running, completed). An unknown value matches nothing.'),
  newestFirst: z.boolean().optional(),
  cursor: id.optional().describe('nextCursor of the previous page.'), limit: z.number().int().min(1).max(1000).optional() };
// A command is either shell text (PowerShell on Windows, sh elsewhere) or an exact executable launch.
export const commandShape = { command: z.string().min(1).max(100000).optional(), file: z.string().min(1).max(4096).optional(),
  args: z.array(z.string().max(100000)).max(2000).optional(), cwd: z.string().max(4096).optional(),
  timeoutMs: z.number().int().min(1000).max(86400000).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,199}$/), z.string().max(32768)).optional().describe('Environment variables for this command only, beside the ones every command gets.') };
// Words to look for in a list of tools: every one of them has to be in the name or the description.
export const keywords = z.string().min(1).max(200).optional().describe('Words to look for in names and descriptions; all of them have to be there.');
export const hasWords = (query, ...texts) => { const where = texts.join(' ').toLowerCase().replace(/[._]/g, ' '); return String(query).toLowerCase().replace(/[._]/g, ' ').split(/\s+/).filter(Boolean).every(word => where.includes(word)); };

export const now = () => new Date().toISOString();
export const hash = value => createHash('sha256').update(value).digest('hex');
// client: sent through a connected client, not by the owner at this computer. A task that comes that way is run
// by a coding agent only with the owner's word (delegation.read).
// It is named as that too: an agent that reads who wrote to it is not told "You", which is the owner at the computer.
export const actor = context => context.surface === 'local' ? { id: context.id, kind: 'user', label: 'You' } : { id: context.id, kind: 'user', label: 'Connected client', client: true };
// The command line that calls an operation with an input, as the owner types it on this computer. The shells of
// Windows take the double quotes out of an argument, so there the input goes through a file.
export const ownerCommand = (operation, json, platform = process.platform) => 'devmate ' + operation + (platform === 'win32' ? ' --file <a file that holds ' + json + '>' : ' --json \'' + json + '\'');
export const within = (root, target) => { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
export const oneCommand = value => {
  if ((value.command === undefined) === (value.file === undefined)) throw new DomainError('invalid_command', 'Supply either command text or an executable file with args.');
  if (value.command !== undefined && value.args !== undefined) throw new DomainError('invalid_command', 'args applies only to an executable file.');
  // The command's own variables. DevMate's are not the caller's to set: among them is the mark by which the devmate
  // command line knows that a connected client started it, and not the owner at this computer.
  const { env, ...command } = value;
  if (env === undefined) return command;
  const names = Object.keys(env);
  if (names.length > 64) throw new DomainError('invalid_command', 'env takes at most 64 variables.');
  const reserved = names.find(name => name.toUpperCase().startsWith('DEVMATE_'));
  if (reserved) throw new DomainError('invalid_command', reserved + ' is one of DevMate\'s own variables and is not set by a command.');
  return { ...command, environment: env };
};
