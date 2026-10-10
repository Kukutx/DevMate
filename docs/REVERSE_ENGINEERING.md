# Reverse engineering

The `reverse` engine inspects binary files of a project with built-in parsers, can hand analysis to installed backends, and on Windows can inspect and carefully change the memory of a process the owner selects. It is for authorized testing of your own software. Capabilities are called through `capability_call`:

```json
{ "capability": "reverse.binary_info", "input": { "path": "build/game.exe" } }
```

Listing, flags and settings are described in [CAPABILITIES.md](CAPABILITIES.md); installed backends in [REVERSE_BACKENDS.md](REVERSE_BACKENDS.md).

## Who may call what

| Capabilities | Reach | Callers |
|---|---|---|
| `status`, `toolchain`, `binary_info`, `strings`, `hex_read`, `bytes_search`, `value_codec`, `address_map`, `binary_diff` | project files, built-in code only | anyone with read access |
| `patch_copy` | writes a new project file | read access for a dry run, write access to create the copy |
| `disassemble`, `code_analyze`, `decompile` | start Python, Rizin/radare2 or Ghidra | owner only |
| `processes`, `session_open`, `sessions`, `session_close`, `modules`, `memory_regions`, `memory_read`, `memory_search`, `value_scan`, `value_rescan`, `scan_results`, `scan_close`, `pointer_chain`, `pointer_references`, `memory_write`, `memory_restore` | memory of a local process | owner only, and only with `allowProcessAccess` |

With `auth.mode: none` every caller is the owner. For other callers `binary_info` in auto mode uses the built-in parser and says so, and `probe: true` on `status` and `toolchain` reports that probes are the owner's.

Process access and memory writes are off by default. The owner enables them explicitly:

```json
{ "engine": "reverse", "settings": { "allowProcessAccess": true } }
```

(`capability.configure`.) `allowMemoryWrite` is a second, separate switch.

## Static analysis

- `binary_info`: SHA-256, entropy, and with the built-in parser PE32/PE32+ sections, import and export tables, ordinal imports, forwarders and selected mitigation flags, or ELF32/64 header and sections in either byte order. Mach-O is only recognized as a candidate by its magic number.
- `strings`: printable ASCII, or printable ASCII code units stored as UTF-16LE/BE, with byte offsets and a continuation offset. Not a full Unicode extractor.
- `hex_read`: up to 16 KiB per call as hex and ASCII.
- `bytes_search`: an array-of-bytes pattern with byte and nibble wildcards (`48 8B ?? A? ?F`) or one encoded numeric value; overlapping matches, alignment, continuation.
- `value_codec`: encode or decode `int8`…`uint64`, `float32`, `float64`. 64-bit integers are decimal strings.
- `address_map`: PE file offset, RVA and preferred-image VA conversion. It does not know a runtime ASLR base; `modules` gives real bases.
- `binary_diff`: paged changed ranges of two files with both hashes.

The built-in PE parser does not decode resources, relocations, debug information, delay imports, CLR metadata or signatures; the ELF parser does not decode symbol tables or program headers. Mitigation fields report header flags, not that a running program is protected.

## Patching a copy

`patch_copy` never changes the source file. It takes the source SHA-256 and a list of `{ offset, expectedHex, replacementHex }` patches, and by default only plans (`dryRun: true`). Creating the copy needs `dryRun: false`, `confirm: true` and a new `outputPath`. Patches keep their length, may not overlap, must match the current bytes, and total at most 64 KiB in at most 128 patches. An existing output path is refused. Checksums and signatures inside the file are not recalculated.

## Finding a changing value in a process

Windows and a 64-bit Python are required. Nothing here attaches a debugger, injects code or elevates privileges.

1. `reverse.processes` lists names and PIDs. `reverse.session_open` binds one explicit PID, with its creation time and image path, to a session of this project. A reused PID is rejected later.
2. `reverse.modules` and `reverse.memory_regions` show where to look. Addresses are hexadecimal strings.
3. `reverse.value_scan` over an explicit range:

```json
{
  "capability": "reverse.value_scan",
  "input": { "sessionId": "<session id>", "address": "0x0000010000000000", "length": 1048576, "dataType": "int32", "comparison": "equal", "value": 100 }
}
```

Initial comparisons: `equal`, `not_equal`, `between` (with `upperValue`), `unknown`.

4. Change the value in the program, then `reverse.value_rescan` with the returned `scanId` and `expectedRevision`. Rescan comparisons also include `changed`, `unchanged`, `increased`, `decreased`, `increased_by`, `decreased_by`. Each rescan compares with the previous successful scan, advances the revision and rejects a stale one.
5. `reverse.scan_results` pages through the remaining candidates. `reverse.pointer_chain` resolves a known chain; `reverse.pointer_references` finds one-level references to an address in a range.

A candidate cap or the time budget returns `complete: false` with `nextAddress`; unreadable ranges are counted as skipped. An empty result from an incomplete scan does not prove a value is absent. Scans read a changing process: they are observations, not an atomic snapshot.

## Writing process memory

`reverse.memory_write` plans by default (`dryRun: true`). A real write needs `allowMemoryWrite`, `dryRun: false`, `confirm: true`, the exact current bytes (`expectedHex`) and replacement bytes of equal length: 1 to 256 bytes wholly inside one committed, private, writable, non-executable region. Page protections are never changed. The helper checks, writes once and reads back; check `verified`. Check and write are not atomic.

A verified write returns a `writeId`. `reverse.memory_restore` puts the original bytes back only while memory still holds the bytes that were written. A session keeps 16 receipts in memory; closing the session or restarting the runtime discards them and reverts nothing.

## Limits

| Resource | Limit |
|---|---:|
| File size | 64 MiB by default, `maxFileBytes` 1 to 256 MiB |
| Helper runs at once / backend runs at once | 2 / 2; more are refused, not queued |
| Helper timeout | 15 s by default, `nativeTimeoutMs` 2 to 30 s |
| Memory range per scan or search | 64 MiB |
| Sessions per project | 8 |
| Idle session lifetime | 15 min by default, `sessionTtlMs` 1 to 60 min |
| Scans per session / candidates per scan | 4 / 5000 |
| Memory read, hex read | 16 KiB per call |
| Disassembly | 8 KiB input, 1000 instructions |

Sessions, scans and receipts live in memory only and are lost on a runtime restart. A session accepts one operation at a time.

## Cancellation and boundaries

- Paths are project-relative; links and credential-like paths are refused.
- The helper is fixed Python source started without a shell, in isolated mode, outside the project, with the allow-listed child environment. Cancelling a call kills it and waits for its exit.
- Permission, engine state and cancellation are checked again after the audit event of each operation, before anything is started or written.
- Audit events record the operation, target PID and write verification, never memory contents.

## Tests

`tests/reverse-core.test.mjs`, `tests/reverse-plugin.test.mjs`, `tests/reverse-audit.test.mjs`, `tests/reverse-native.test.mjs` (the Windows process test targets only a child process the test itself starts), `tests/reverse-engines.test.mjs`, and `tests/capability-catalog.test.mjs` for the owner-only and read-only rules.
