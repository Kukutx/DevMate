import { z } from 'zod';
import { analyzeWithEngine, reverseToolchain } from './reverse-engines.mjs';

export function registerReverseEngineTools(context, register, { filePath, addressSchema }) {
  register('reverse_toolchain', 'Discover optional reverse-engineering tools and setup guidance. probe=true checks imports/version commands, not analysis correctness. Does not install anything or change configuration.', {
    probe: z.boolean().default(false)
  }, args => reverseToolchain(context, args.probe));

  register('reverse_code_analyze', 'Analyze a workspace binary with installed Rizin/radare2, or Ghidra for functions/xrefs. Returns paged backend JSON and the source hash. Commands are fixed; user scripts and arbitrary backend commands are not accepted. Auto selects an installed engine; analysis errors are not silently hidden.', {
    path: filePath,
    engine: z.enum(['auto', 'rizin', 'radare2', 'ghidra']).default('auto'),
    query: z.enum(['functions', 'xrefs', 'symbols', 'imports', 'exports', 'sections', 'disassembly']),
    address: addressSchema.optional(),
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(1000).default(200),
    analysisSeconds: z.number().int().min(1).max(180).default(60)
  }, args => {
    if (args.engine === 'ghidra' && !['functions', 'xrefs'].includes(args.query)) throw new Error('Ghidra adapter supports functions/xrefs here; use Rizin/radare2 for this query');
    if (args.query === 'disassembly' && args.offset !== 0) throw new Error('Disassembly uses address continuation, not offset pagination');
    return analyzeWithEngine(context, context.workspace.get(args.workspaceId), args);
  }, { readOnly: false, idempotent: true });

  register('reverse_decompile', 'Decompile one function containing an explicit address using separately installed Ghidra and PyGhidra 3+. Uses a disposable project and never executes the input. Missing runtimes are errors, not fabricated pseudocode. Decompiled C is not original source.', {
    path: filePath, address: addressSchema,
    analysisSeconds: z.number().int().min(1).max(180).default(60),
    decompileSeconds: z.number().int().min(1).max(60).default(30),
    maxChars: z.number().int().min(1000).max(100000).default(30000)
  }, args => analyzeWithEngine(context, context.workspace.get(args.workspaceId), { ...args, query: 'decompile', engine: 'ghidra' }), { readOnly: false, idempotent: true });
}
