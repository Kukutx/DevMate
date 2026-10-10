import { z } from 'zod';
import { DomainError } from '../store.mjs';
import { actor, commandShape, id, jobFor, listOptions, mutation, oneCommand, projectScope, waitMs } from './shared.mjs';

// Commands a caller runs and follows directly (shell.run, process.*), and durable jobs
// that outlive the request that started them (job.*).
export function defineCommandOperations(service, add) {
  // The hint is a complete call. Without waitMs a read answers at once, and a model following the hint would poll in a tight loop.
  const processOutput = result => (result.skippedBytes ? '[earlier output omitted: ' + result.skippedBytes + ' bytes; page it with process_read cursor:0]\n' : '') + result.output +
    '\n[' + (result.status === 'running' ? 'still running; process_read {id:"' + result.id + '", cursor:' + result.cursor + ', waitMs:30000} waits for more output, process_stop ends it'
      : result.status + (result.exitCode !== null ? ', exit code ' + result.exitCode : '')) + ']';
  const processMeta = ['id', 'status', 'exitCode', 'cursor', 'hasMore'];
  const projectOf = args => service.processes.projectOf(args.id);
  // A wait that ended because the runtime is stopping is not an observation of the command: say so instead of "still running".
  const observed = async work => {
    const result = await work;
    if (service.execution.signal.aborted && result.status === 'running') throw new DomainError('runtime_stopping', 'The runtime is stopping and this command is being ended with it. Its outcome was not observed.');
    return result;
  };
  add('shell.run', { ...projectScope, ...commandShape, waitMs, interactive: z.boolean().optional(), ...mutation }, false,
    'Run a command in the project: tests, builds, package managers, Git writes, dev servers. command is ' + service.processes.shell.label +
    (service.processes.shell.noChaining ? ' text (no && or ||: chain with ";" and "if ($?) { ... }")' : ' text') + '; file+args launches one executable with exact arguments and no shell quoting (useful for a commit message). Returns when the command exits or after waitMs (default 30s, at most 50s); a still-running command, such as a dev server, keeps running until it exits or you stop it and is followed with process_read. timeoutMs ends it automatically. Output is paged by cursor; the newest 64 MiB are kept.',
    (args, context) => observed(service.processes.run(service.project(args.projectId, { write: true }), { ...oneCommand(args), caller: context.id }, { signal: service.waitSignal(context) })),
    { destructive: true, openWorld: true, present: processOutput, meta: processMeta });
  add('process.list', { ...projectScope }, true, 'List commands started in this project during the current runtime session.', args => {
    service.project(args.projectId);
    return service.processes.list(args.projectId);
  });
  add('process.read', { id, cursor: z.number().int().nonnegative().optional(), waitMs,
    maxBytes: z.number().int().min(16).max(131072).optional() }, true,
    'Read output of a command. Without cursor returns the latest output; with cursor returns from that byte offset. waitMs waits for new output or exit.',
    (args, context) => observed(service.processes.read(args, { signal: service.waitSignal(context) })), { present: processOutput, meta: processMeta, projectOf });
  add('process.write', { id, input: z.string().max(100000), end: z.boolean().optional(), ...mutation }, false,
    'Send text to the standard input of a command started with interactive:true. Include the newline yourself.',
    args => service.processes.write(args), { projectOf, openWorld: true });
  add('process.stop', { id, ...mutation }, false, 'Stop a running command and its whole process tree.',
    args => service.processes.stop(args), { projectOf, idempotent: true });

  const caller = context => ({ id: context.id, role: context.role, authVersion: context.authVersion ?? null });
  add('job.start', { ...projectScope, workflowId: id.optional(), kind: z.enum(['command', 'capability']),
    input: z.record(z.string(), z.unknown()).describe('For kind command: what shell_run takes (command, or file with args; cwd; timeoutMs). For kind capability: what capability_call takes.'),
    ...mutation }, false, 'Start a durable command or capability job and return immediately.', (args, context) => {
      service.project(args.projectId, { write: args.kind === 'command' });
      if (args.workflowId) service.agents.scope(args.projectId, args.workflowId);
      if (args.input.projectId && service.resolveProjectReference(args.input.projectId, context) !== args.projectId) throw new DomainError('scope_mismatch', 'Job input belongs to another project.');
      let parsed;
      try {
        parsed = args.kind === 'command'
          ? oneCommand(z.object({ ...projectScope, ...commandShape }).strict().parse({ ...args.input, projectId: args.projectId }))
          : service.operations.get('capability.call').schema.parse({ ...args.input, projectId: args.projectId });
      } catch (error) {
        if (error.name !== 'ZodError') throw error;
        throw new DomainError('invalid_input', 'Invalid job input: ' + error.issues.slice(0, 6).map(issue => (issue.path.length ? issue.path.join('.') + ': ' : '') + issue.message).join('; ') +
          '. A command job takes what shell_run takes (command, or file with args, cwd, timeoutMs); a capability job takes what capability_call takes.');
      }
      delete parsed.operationId;
      return service.jobs.start({ projectId: args.projectId, workflowId: args.workflowId, kind: args.kind, input: { args: parsed, caller: caller(context) } });
    }, { destructive: true, openWorld: true });
  add('job.list', listOptions, true, 'List native turns, commands and capability jobs, without their output. job.read returns one job with all of it.', (args, context) => {
    const page = service.list('job', args, context);
    // A list is for finding a job; each may hold a quarter megabyte of output.
    return { ...page, items: page.items.map(item => { const { output, ...job } = jobFor(item, context); return { ...job, outputChars: output?.length || 0, ...(output ? { outputTail: output.slice(-400) } : {}) }; }) };
  });
  add('job.read', { id }, true, 'Read one job including output and outcome evidence.', (args, context) => jobFor(service.store.get('job', args.id), context));
  add('job.cancel', { id, ...mutation }, false, 'Cancel an owned job and inspect its confirmed outcome.', args => {
    const job = service.store.get('job', args.id);
    if (job.kind !== 'agent-turn') return service.jobs.cancel(args.id);
    if (job.status !== 'running') throw new DomainError('job_not_running', 'Job is not running.');
    return service.agents.cancel(job.agentId);
  });
  add('job.retry', { id, ...mutation }, false, 'Explicitly create a new execution for a failed, cancelled or uncertain job.', (args, context) => {
    const job = service.store.get('job', args.id);
    if (job.kind !== 'agent-turn') {
      if (context.role !== 'owner' && job.input.caller.id !== context.id) throw new DomainError('forbidden', 'Only the original caller or owner can retry this execution.');
      service.project(job.projectId, { write: job.kind === 'command' });
      return service.jobs.retry(args.id, caller(context));
    }
    if (!['failed', 'unknown', 'cancelled'].includes(job.status)) throw new DomainError('job_not_retryable', 'Only failed, unknown or cancelled jobs can be explicitly retried.');
    const delivery = service.store.get('delivery', job.deliveryId);
    const original = service.store.get('message', delivery.messageId);
    return service.agents.send({ projectId: job.projectId, workflowId: job.workflowId, recipientIds: [job.agentId], body: original.body, taskId: job.taskId }, actor(context));
  }, { destructive: true, openWorld: true });
}
