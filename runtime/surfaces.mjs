import { z } from 'zod';
import { fileText, line, projectPath, projectReference } from './operations/shared.mjs';

// The tools a model is shown depend on which model it is: one trained on Codex's tools is given apply_patch,
// exec_command and write_stdin, one trained on Claude Code's is given write, edit and bash, and a client that is
// not recognised gets DevMate's own names. This is presentation only. Every tool here is a call of an operation,
// and the service authorizes that call like any other; every tool of every surface can be called by anyone who
// may call its operation, whatever list they were shown.

/** Which surface a client gets: by what it says it is, by how it reached the runtime, or as the owner chose in the address. */
export function clientSurface({ chosen, name, userAgent, tunnel } = {}) {
  if (['gpt', 'claude', 'generic'].includes(chosen)) return chosen;
  const said = String(name || '') + ' ' + String(userAgent || '');
  if (/openai|chatgpt|codex|\bgpt\b/i.test(said)) return 'gpt';
  if (/claude|anthropic/i.test(said)) return 'claude';
  // OpenAI's tunnel carries ChatGPT and nothing else.
  return tunnel ? 'gpt' : 'generic';
}

// What stays a tool of its own on every surface; everything else is an operation, one generic call away.
const CORE = ['project.overview', 'workspace.find', 'workspace.search', 'git.status', 'git.diff', 'editor.diagnostics', 'process.stop',
  'agents.delegate', 'agents.result', 'operations.list', 'operations.query', 'operations.call'];
export const SURFACES = Object.freeze({
  generic: { native: [], direct: [...CORE, 'workspace.read', 'workspace.edit', 'workspace.patch', 'workspace.write', 'shell.run', 'process.read'], names: {} },
  gpt: { native: ['read', 'apply_patch', 'exec_command', 'write_stdin'], direct: CORE,
    names: { 'workspace.read': 'read', 'workspace.patch': 'apply_patch', 'workspace.edit': 'apply_patch', 'workspace.write': 'apply_patch', 'shell.run': 'exec_command', 'process.read': 'write_stdin', 'process.write': 'write_stdin' } },
  claude: { native: ['read', 'write', 'edit', 'bash'], direct: [...CORE, 'process.read'],
    names: { 'workspace.read': 'read', 'workspace.write': 'write', 'workspace.edit': 'edit', 'shell.run': 'bash' } }
});

/**
 * A text written with DevMate's own tool names, as a client of this surface has to read it: a tool it was given
 * keeps its name or gets the surface's, and anything else is named as the operation it is (with a dot), which the
 * generic calls take.
 */
export function respell(text, surface, known) {
  const { direct, names } = SURFACES[surface] || SURFACES.generic;
  return String(text).replace(known, name => {
    const operation = name.replace('_', '.');
    return names[operation] || (direct.includes(operation) ? name : operation);
  });
}

const project = { projectId: projectReference.optional().describe('Project id, root directory or unique name; needed only when several projects are shared.') };
// A budget in tokens, as these models count their context: about four characters each.
const CHARS_PER_TOKEN = 4, DEFAULT_TOKENS = 10000, MAX_TOKENS = 100000, MAX_CHARS = 120000;
const tokens = z.number().int().min(100).max(MAX_TOKENS).optional().describe('How much output to return, in tokens (default ' + DEFAULT_TOKENS + '). Longer output keeps its beginning and its end.');
// How long one call waits before it hands back what there is. A chat host ends a call that takes much longer.
const YIELD_MS = 10000, YIELD_MAX_MS = 12000, POLL_MS = 5000, AFTER_WRITE_MS = 250;
const yieldMs = fallback => z.number().int().min(0).max(YIELD_MAX_MS).optional().describe('How long to wait for output before returning, in milliseconds (default ' + fallback + ', at most ' + YIELD_MAX_MS + '). The command keeps running either way.');

function budgeted(text, maxTokens) {
  const limit = Math.min(MAX_CHARS, (maxTokens || DEFAULT_TOKENS) * CHARS_PER_TOKEN);
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return text.slice(0, half) + '\n[… ' + (text.length - 2 * half) + ' characters of output left out here …]\n' + text.slice(text.length - half);
}
// Where each running command was last read up to, so that the next look returns only what is new.
const cursors = new Map();
function remember(result) {
  cursors.delete(result.id);
  if (result.status === 'running') { cursors.set(result.id, result.cursor); if (cursors.size > 500) cursors.delete(cursors.keys().next().value); }
}
function session(result, maxTokens) {
  remember(result);
  const state = result.status === 'running' ? 'Process running with session ID ' + result.id : 'Process ' + result.status + (result.exitCode !== null ? ' with code ' + result.exitCode : '');
  return { content: [{ type: 'text', text: state + (result.skippedBytes ? '\n[' + result.skippedBytes + ' bytes of earlier output are not shown]' : '') + '\nOutput:\n' + budgeted(result.output || '', maxTokens) }] };
}

/**
 * The tools of the model-native surfaces. run({ call, present, shell }, input) calls operations through the service
 * and returns an MCP tool result; present(operation, result) gives a result the form that operation's own tool gives it.
 */
export const NATIVE_TOOLS = Object.freeze({
  read: { title: 'Read file', labels: ['Reading a file', 'Read a file'], readOnly: true,
    description: () => 'Read a text file of the project with line numbers. A long file comes a page at a time: continue with offset set to nextStartLine.',
    shape: { path: projectPath, offset: line.optional().describe('First line to return, counted from 1.'), limit: line.max(20000).optional().describe('How many lines to return.'), ...project },
    run: async ({ call, present }, input) => present('workspace.read', await call('workspace.read', { projectId: input.projectId, path: input.path, startLine: input.offset, lineCount: input.limit })) },
  apply_patch: { title: 'Apply patch', labels: ['Applying a patch', 'Applied a patch'], destructive: true, operation: 'workspace.patch',
    shape: { patch: fileText.min(1).describe('The whole patch, from "*** Begin Patch" to "*** End Patch".'), ...project },
    run: async ({ call, present }, input) => present('workspace.patch', await call('workspace.patch', { projectId: input.projectId, patch: input.patch })) },
  exec_command: { title: 'Run command', labels: ['Running a command', 'Ran a command'], destructive: true, openWorld: true,
    description: shell => 'Run a command in the project, in ' + shell.label + (shell.noChaining ? ' (no && or ||: chain with ";" and "if ($?) { ... }")' : '') +
      ': tests, builds, package managers, Git. It returns when the command exits or after yield_time_ms; a command that is still running then keeps running and is followed, given input and waited for with write_stdin and its session ID.',
    shape: { cmd: z.string().min(1).max(100000).describe('The command line.'), working_directory: z.string().max(4096).optional().describe('Folder to run in, relative to the project root.'),
      yield_time_ms: yieldMs(YIELD_MS), max_output_tokens: tokens, ...project },
    run: async ({ call }, input) => session(await call('shell.run', { projectId: input.projectId, command: input.cmd, cwd: input.working_directory, interactive: true,
      waitMs: input.yield_time_ms ?? YIELD_MS }), input.max_output_tokens) },
  write_stdin: { title: 'Follow command', labels: ['Following a command', 'Followed a command'], openWorld: true,
    description: () => 'Send text to a running command (include the newline yourself), or with no chars just wait for its next output. Returns what the command printed since the last look, and whether it is still running.',
    shape: { session_id: z.string().min(1).max(160).describe('The session ID exec_command returned.'), chars: z.string().max(100000).optional().describe('Text for the command\'s standard input. Leave out to only read.'),
      yield_time_ms: yieldMs(AFTER_WRITE_MS + ' after sending text, ' + POLL_MS + ' when only waiting'), max_output_tokens: tokens },
    run: async ({ call }, input) => {
      if (input.chars) await call('process.write', { id: input.session_id, input: input.chars });
      return session(await call('process.read', { id: input.session_id, cursor: cursors.get(input.session_id), waitMs: input.yield_time_ms ?? (input.chars ? AFTER_WRITE_MS : POLL_MS) }), input.max_output_tokens);
    } },
  write: { title: 'Write file', labels: ['Writing a file', 'Wrote a file'], destructive: true,
    description: () => 'Create a file, or replace the whole content of an existing one. Missing folders are created; the version that was there stays restorable. To change part of a file use edit.',
    shape: { path: projectPath, content: fileText, ...project },
    run: async ({ call, present }, input) => present('workspace.write', await call('workspace.write', { projectId: input.projectId, path: input.path, text: input.content, overwrite: true })) },
  edit: { title: 'Edit file', labels: ['Editing a file', 'Edited a file'],
    description: () => 'Change a text file by exact replacement. Each old_text must occur exactly once in the file (add surrounding lines until it does); the edits apply in order, and all of them or none are written. Copy old_text from read without the line-number prefix.',
    shape: { path: projectPath, edits: z.array(z.object({ old_text: z.string().min(1).max(100000), new_text: z.string().max(100000) }).strict()).min(1).max(200), ...project },
    run: async ({ call, present }, input) => present('workspace.edit', await call('workspace.edit', { projectId: input.projectId, path: input.path,
      edits: input.edits.map(item => ({ oldText: item.old_text, newText: item.new_text })) })) },
  bash: { title: 'Run command', labels: ['Running a command', 'Ran a command'], destructive: true, openWorld: true,
    description: shell => 'Run a command in the project. The shell here is ' + shell.label + (shell.noChaining ? ' (no && or ||: chain with ";" and "if ($?) { ... }")' : '') +
      ': tests, builds, package managers, Git. It returns when the command exits, or after ten seconds (with timeout: after up to 50 seconds); a command still running then keeps running and is followed with process_read and ended with process_stop.',
    shape: { command: z.string().min(1).max(100000), working_directory: z.string().max(4096).optional().describe('Folder to run in, relative to the project root.'),
      timeout: z.number().int().min(1000).max(86400000).optional().describe('End the command after this many milliseconds.'), ...project },
    run: async ({ call, present }, input) => present('shell.run', await call('shell.run', { projectId: input.projectId, command: input.command, cwd: input.working_directory,
      ...(input.timeout ? { timeoutMs: input.timeout, waitMs: Math.min(input.timeout, 50000) } : {}) })) }
});
