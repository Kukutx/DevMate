import { z } from 'zod';
import { definePlugin } from './plugin-sdk.mjs';
import { decodeValue, encodeValue, extractStrings, hexAddress, hexBytes, searchBytes, VALUE_TYPES, valueType } from './reverse-values.mjs';
import { inspectFormat, mapPEAddress } from './reverse-formats.mjs';
import { inspectWithEngine, reverseToolchain, stopReverseEngines } from './reverse-engines.mjs';
import { registerReverseEngineTools } from './reverse-engine-tools.mjs';
import { diffBinaries, patchCopy, readBinary } from './reverse-files.mjs';
import { pythonExecutable, runNative, stopNativeHelpers } from './reverse-native.mjs';
import { registerReverseProcessTools } from './reverse-process-tools.mjs';

const filePath = z.string().min(1).max(2000);
const offsetSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0);
const typeSchema = z.enum(VALUE_TYPES).default('int32');
const endianSchema = z.enum(['little', 'big']).default('little');
const addressSchema = z.union([z.string().regex(/^(?:0x[0-9a-f]+|[0-9]+)$/i).max(40), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]);
const valueSchema = z.union([z.string().min(1).max(100), z.number().finite()]);
export const reverseSettingsSchema = z.object({
  pythonPath: z.string().max(2000).default(''),
  rizinPath: z.string().max(2000).default(''),
  radare2Path: z.string().max(2000).default(''),
  ghidraInstallDir: z.string().max(2000).default(''),
  binaryEngine: z.enum(['auto', 'lief', 'pefile', 'pyelftools', 'builtin']).default('auto'),
  allowBuiltinFallback: z.boolean().default(true),
  analysisTimeoutMs: z.number().int().min(5000).max(300000).default(120000),
  allowProcessAccess: z.boolean().default(false),
  allowMemoryWrite: z.boolean().default(false),
  maxFileBytes: z.number().int().min(1048576).max(268435456).default(67108864),
  nativeTimeoutMs: z.number().int().min(2000).max(30000).default(15000),
  sessionTtlMs: z.number().int().min(60000).max(3600000).default(900000)
}).strict();

async function status(context, probe = false) {
  let pythonAvailable = false, pythonError = null;
  try { pythonExecutable(context); pythonAvailable = true; } catch (error) { pythonError = error.message; }
  const result = {
    engine: 'reverse', version: '0.2.0', platform: process.platform,
    staticAnalysis: { formats: ['PE', 'ELF', 'Mach-O via LIEF', 'raw'], strings: ['ascii', 'utf16le', 'utf16be'], valueTypes: VALUE_TYPES, patchMode: 'new copy only', preferredEngine: context.settings.binaryEngine },
    pythonAvailable, pythonError, processAccessEnabled: context.settings.allowProcessAccess,
    memoryWriteEnabled: context.settings.allowMemoryWrite,
    limits: { maxFileBytes: context.settings.maxFileBytes, maxSessions: 8, scansPerSession: 4, candidatesPerScan: 5000, nativeProcesses: 2, externalProcesses: 2, scanBytes: 67108864, nativeTimeoutMs: context.settings.nativeTimeoutMs, analysisTimeoutMs: context.settings.analysisTimeoutMs, sessionTtlMs: context.settings.sessionTtlMs },
    limitations: ['Process memory requires Windows and 64-bit Python', 'Disassembly requires separately installed Capstone', 'Code analysis requires Rizin/radare2 or Ghidra; decompilation requires PyGhidra and Ghidra', 'No debugger attachment, protection bypass, injection, code-page writes, or persistent value freezing',
      'Installed backends and process memory are available only to the owner; other callers use the built-in parsers'],
    configure: 'The owner sets pythonPath, rizinPath, radare2Path, ghidraInstallDir, allowProcessAccess and allowMemoryWrite with capability.configure {engine:"reverse", settings:{…}}'
  };
  if (probe && pythonAvailable && context.caller() === 'owner') {
    try { result.nativeProbe = await runNative(context, 'status'); }
    catch (error) { result.nativeProbe = { available: false, error: error.message }; }
  }
  result.toolchain = await reverseToolchain(context, probe);
  return result;
}

export const reversePlugin = definePlugin({
  manifest: {
    id: 'devmate.reverse', name: 'Reverse Engineering', version: '0.2.0',
    description: 'Binary inspection with built-in parsers, plus owner-only Rizin/radare2 code analysis, Ghidra decompilation, Capstone disassembly and bounded Windows process-memory workflows.',
    permissions: { executablePatterns: ['^python(?:3(?:\\.\\d+)?)?(?:\\.exe)?$', '^(?:rizin|radare2|r2)(?:\\.exe)?$'] }
  },
  settingsSchema: reverseSettingsSchema,
  defaultSettings: reverseSettingsSchema.parse({}),
  diagnose: context => status(context, true),
  async deactivate(context) { context.state.sessions.clear(); await Promise.all([stopNativeHelpers(context.state.native), stopReverseEngines(context.state.engines)]); },
  activate(context) {
    // ownerOnly: reaches a local process or starts an installed analysis backend.
    // readOnlyWhen: the inputs for which a tool that can write only plans.
    const register = (name, description, shape, handler, { readOnly = true, destructive = false, idempotent = readOnly, ownerOnly = false, longRunning = false, readOnlyWhen } = {}) => {
      const inputSchema = { workspaceId: z.string().max(200).optional(), ...shape };
      const validated = z.object(inputSchema).strict();
      context.server.registerTool(name, {
        title: name.replaceAll('_', ' '), description, inputSchema, ownerOnly, longRunning, readOnlyWhen,
        annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false }
      }, async input => {
        context.assertActive();
        const args = validated.parse(input || {});
        for (const key of ['address', 'targetAddress']) if (args[key] !== undefined) args[key] = hexAddress(args[key]);
        return context.toolText(await handler(args));
      });
    };
    const workspace = args => context.workspace.get(args.workspaceId);
    const binary = args => readBinary(context, workspace(args), args.path);

    register('status', 'Inspect reverse-analysis capabilities and limits. probe=true also runs the installed engines to check them (owner only); no dependencies are installed.', { probe: z.boolean().default(false) }, args => status(context, args.probe));

    register('binary_info', 'Inspect a project binary. The owner gets LIEF, pefile or pyelftools when installed; auto mode falls back to the limited built-in parser, labels it, and is what other callers get. Includes the selected backend/version and source hash; never executes the input.', {
      path: filePath, engine: z.enum(['auto', 'lief', 'pefile', 'pyelftools', 'builtin']).optional(), maxEntries: z.number().int().min(1).max(5000).default(1000)
    }, args => inspectWithEngine(context, workspace(args), args));

    register('strings', 'Extract printable ASCII strings or printable ASCII code units stored in UTF-16, with byte offsets, bounded previews and a continuation offset. Does not claim full Unicode decoding.', {
      path: filePath, encoding: z.enum(['ascii', 'utf16le', 'utf16be']).default('ascii'), offset: offsetSchema,
      minLength: z.number().int().min(2).max(256).default(4), maxLength: z.number().int().min(2).max(4096).default(256), limit: z.number().int().min(1).max(1000).default(200)
    }, async args => { const input = await binary(args); return { path: args.path, sha256: input.sha256, ...await extractStrings(input.bytes, args) }; });

    register('hex_read', 'Read a bounded binary file range as hex and printable ASCII; offsets are file offsets, not virtual addresses.', {
      path: filePath, offset: offsetSchema, length: z.number().int().min(1).max(16384).default(256)
    }, async args => {
      const input = await binary(args);
      if (args.offset > input.size) throw new Error('Offset is beyond end of file');
      const bytes = input.bytes.subarray(args.offset, args.offset + args.length);
      return { path: args.path, sha256: input.sha256, offset: args.offset, length: bytes.length, hex: bytes.toString('hex'), ascii: [...bytes].map(value => value >= 32 && value <= 126 ? String.fromCharCode(value) : '.').join(''), eof: args.offset + bytes.length === input.size };
    });

    register('bytes_search', 'Search a binary for an AoB pattern with byte/nibble wildcards, or one encoded numeric value. Supports overlapping matches, alignment and continuation. Supply pattern OR value.', {
      path: filePath, pattern: z.string().min(1).max(768).optional(), value: valueSchema.optional(), dataType: typeSchema, endian: endianSchema,
      offset: offsetSchema, alignment: z.number().int().min(1).max(4096).default(1), limit: z.number().int().min(1).max(5000).default(200)
    }, async args => {
      if ((args.pattern !== undefined) === (args.value !== undefined)) throw new Error('Supply exactly one of pattern or value');
      const input = await binary(args);
      const pattern = args.pattern || [...encodeValue(args.value, args.dataType, args.endian)].map(value => value.toString(16).padStart(2, '0')).join(' ');
      return { path: args.path, sha256: input.sha256, ...await searchBytes(input.bytes, pattern, args) };
    });

    register('value_codec', 'Encode or decode a typed numeric value. int64/uint64 values are decimal strings to preserve precision. Supply value OR hex.', {
      dataType: typeSchema, endian: endianSchema, value: valueSchema.optional(), hex: z.string().max(100).optional()
    }, async args => {
      if ((args.hex !== undefined) === (args.value !== undefined)) throw new Error('Supply exactly one of hex or value');
      const bytes = args.hex === undefined ? encodeValue(args.value, args.dataType, args.endian) : hexBytes(args.hex, 8);
      if (bytes.length !== valueType(args.dataType).size) throw new Error('Byte count does not match the selected value type');
      return { dataType: args.dataType, endian: args.endian, value: decodeValue(bytes, args.dataType, args.endian), hex: bytes.toString('hex') };
    });

    register('address_map', 'Map a PE file offset, RVA or preferred-image VA with the limited built-in mapper. Virtual zero-fill and overlays have no file-backed mapping; runtime ASLR bases must be handled separately.', {
      path: filePath, address: addressSchema, from: z.enum(['offset', 'rva', 'va']).default('rva')
    }, async args => { const input = await binary(args); return { sha256: input.sha256, backend: 'builtin', ...mapPEAddress(inspectFormat(input.bytes, 1), args.address, args.from) }; });

    register('binary_diff', 'Compare two bounded workspace binaries without modifying them; returns paged changed ranges and both hashes. changedBytesInPage is not a whole-file total when paginated.', {
      leftPath: filePath, rightPath: filePath, offset: offsetSchema, limit: z.number().int().min(1).max(1000).default(200)
    }, async args => {
      const ws = workspace(args);
      const left = await readBinary(context, ws, args.leftPath), right = await readBinary(context, ws, args.rightPath);
      return { leftSha256: left.sha256, rightSha256: right.sha256, ...await diffBinaries(left.bytes, right.bytes, args) };
    });

    register('patch_copy', 'Plan or create a NEW patched binary copy. Requires source SHA-256 and expected bytes; rejects overlaps, resizing and existing output paths. Original is never overwritten. Actual creation requires dryRun=false and confirm=true.', {
      path: filePath, expectedSha256: z.string().regex(/^[0-9a-f]{64}$/i), outputPath: filePath.optional(), dryRun: z.boolean().default(true), confirm: z.boolean().default(false),
      patches: z.array(z.object({ offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), expectedHex: z.string().min(2).max(196608), replacementHex: z.string().min(2).max(196608) }).strict()).min(1).max(128)
    }, args => patchCopy(context, context.workspace.get(args.workspaceId, { writable: !args.dryRun }), args), { readOnly: false, idempotent: false, readOnlyWhen: args => args.dryRun !== false });

    register('disassemble', 'Disassemble bounded bytes using separately installed Python Capstone. Supply a project path or inline hex, explicit architecture and base address; does not execute the binary or decompile it.', {
      path: filePath.optional(), hex: z.string().min(2).max(24576).optional(), offset: offsetSchema, length: z.number().int().min(1).max(8192).default(4096),
      architecture: z.enum(['x86', 'x86_64', 'arm', 'thumb', 'arm64']), endian: endianSchema, address: addressSchema.default('0x0'), count: z.number().int().min(1).max(1000).default(200)
    }, async args => {
      if ((args.path !== undefined) === (args.hex !== undefined)) throw new Error('Supply exactly one of path or hex');
      let bytes, hash;
      if (args.path) { const input = await binary(args); bytes = input.bytes.subarray(args.offset, args.offset + args.length); hash = input.sha256; }
      else bytes = hexBytes(args.hex, 8192);
      if (!bytes.length) throw new Error('No bytes to disassemble');
      return { sourceSha256: hash, ...await runNative(context, 'disassemble', { workspaceId: workspace(args).id, hex: bytes.toString('hex'), architecture: args.architecture, endian: args.endian, address: args.address, count: args.count }) };
    }, { ownerOnly: true });

    registerReverseEngineTools(context, register, { filePath, addressSchema });
    registerReverseProcessTools(context, register, { addressSchema, typeSchema, endianSchema, valueSchema });
  }
});
