# Reverse Engineering plugin

`devmate.reverse` is an opt-in, owner-only analysis plugin. It provides 29 structured tools for agents inspecting their own software, offline test programs, save/configuration data, and other explicitly authorized targets. It does not install dependencies or execute analyzed binaries.

Version `0.2.0` prefers mature installed backends rather than extending the custom parsers. See [Mature reverse backends](REVERSE_BACKENDS.md) for LIEF/pefile/pyelftools selection, Rizin/radare2 analysis, current PyGhidra integration, diagnostics and setup. This is an adapter layer, not a claim of parity with the complete upstream tools or proof that an absent backend has been tested. The static-parser coverage described below applies to the explicitly labeled built-in fallback.

## Install and enable

The plugin is bundled with the Gateway. After building/installing the updated DevMate extension, restart the shared runtime and refresh/reconnect the MCP client. An already running older Gateway cannot discover newly added source modules by configuration alone.

1. Call `plugin_enable` with `{"id":"devmate.reverse"}`.
2. Reconnect/refresh the client when its tool list is cached.
3. Call `reverse_status` with `{"probe":true}` to inspect runtime availability.
4. To opt into local process inspection, call `plugin_configure` with:

```json
{
  "id": "devmate.reverse",
  "settings": {
    "allowProcessAccess": true,
    "allowMemoryWrite": false
  }
}
```

Use `pythonPath` in these settings when a 64-bit Python interpreter is not discoverable on PATH. When configured, it must be an absolute path with a Python executable basename; another allowed backend such as Rizin is not a Python interpreter. Never point it at a workspace script. Arguments, shell commands and launchers are not accepted as interpreter paths. The helper uses isolated Python mode, runs outside the workspace, and accepts only a fixed JSON operation protocol.

Static file tools have no new production dependency. Native process tools need **Windows and 64-bit Python**. The optional disassembler needs Capstone installed into that interpreter separately. `reverse_status` distinguishes missing Python, unsupported process-memory platforms, and missing Capstone. No automatic download or installation occurs.

All reverse tools are owner-only in the central tool policy. Static file reads remain workspace-contained; under `fullAccess`, the normal local credential/secret path filter is intentionally bypassed just like other trusted local file/plugin workflows. Helper execution additionally requires `fullAccess`; enabling this plugin is not a grant of operating-system administrator rights. Preserve the project's existing authentication settings; in single-owner `auth.mode: none`, keep the MCP endpoint private to the owner.

## Tool surface

| Group | Tools | Coverage |
|---|---|---|
| Diagnostics | `reverse_status` | Capabilities, interpreter probe, optional engine availability and limits |
| Static binary analysis | `reverse_binary_info`, `reverse_address_map` | SHA-256, entropy; PE32/PE32+ sections, normal import/export tables, ordinal imports, forwarders and selected mitigation flags; ELF32/64 header and sections, either byte order; PE file-offset/RVA/preferred-VA conversion |
| Data analysis | `reverse_strings`, `reverse_hex_read`, `reverse_bytes_search`, `reverse_value_codec`, `reverse_binary_diff` | Bounded reads, printable strings with offsets, wildcard AoB or exact encoded-value search, typed codecs and paginated binary differences |
| File modification | `reverse_patch_copy` | Expected-hash and expected-byte validation; fixed-size patches into a new, exclusive output file |
| Disassembly | `reverse_disassemble` | Optional Capstone adapter for x86, x86-64, ARM, Thumb and ARM64; bytes or workspace file ranges; explicit base address |
| Target sessions | `reverse_processes`, `reverse_session_open`, `reverse_sessions`, `reverse_session_close` | Explicit PID selection; workspace binding, process creation-time/image identity, expiry and cleanup |
| Process inspection | `reverse_modules`, `reverse_memory_regions`, `reverse_memory_read`, `reverse_memory_search` | Runtime module bases, page protections, bounded memory reads and AoB search |
| Numeric scanning | `reverse_value_scan`, `reverse_value_rescan`, `reverse_scan_results`, `reverse_scan_close` | Typed, range-bounded scans, previous-baseline comparisons, revision checks and candidate pagination |
| Pointer inspection | `reverse_pointer_chain`, `reverse_pointer_references` | Known-chain resolution and bounded one-level pointer-reference search |
| Memory modification | `reverse_memory_write`, `reverse_memory_restore` | Opt-in, expected-byte-checked, verified data writes and conflict-checked restoration receipts |

### Static analysis details

Strings are **printable ASCII**, or printable ASCII code units stored in UTF-16LE/BE. This is not a full Unicode text extractor. UTF-16 searching includes odd byte offsets. Long strings return a bounded preview with the observed length and a truncation flag.

PE parsing does not decode resources, relocation entries, debug/PDB information, delay imports, CLR metadata or Authenticode. Mitigation fields report header flags, not proof that a running program is protected. Invalid import/export metadata returns warnings and truncation flags; unsafe structural offsets are rejected. ELF extended numbering, ELF symbol/import tables and program headers are not decoded. Mach-O magic is identified only as a candidate (shared magic signatures are not authoritative format detection).

`reverse_address_map` returns a preferred-image VA, not an ASLR-adjusted runtime address. Use `reverse_modules` to obtain actual module bases. Zero-filled virtual sections and file overlays do not have a bidirectional file-backed mapping.

For raw files, save games and configuration data, use byte search, value codecs, diffs and patch copies. Encoded/compressed/encrypted application-specific data requires format-specific analysis outside this plugin.

## Agent workflow: locate changing values

Always use the same explicit `workspaceId` for the workflow. Session handles are bound to both the workspace ID and its root.

1. Select an authorized process using `reverse_processes`, then open it with `reverse_session_open` and an explicit PID. Opening a session does not attach a debugger.
2. Inspect modules/regions to choose an address range. Addresses should be hexadecimal strings; unsafe numeric addresses are rejected. A scan never silently scans the entire machine.
3. Call `reverse_value_scan`. Example arguments for an already opened session:

```json
{
  "workspaceId": "your-workspace-id",
  "sessionId": "returned-session-uuid",
  "address": "0x0000010000000000",
  "length": 1048576,
  "dataType": "int32",
  "endian": "little",
  "comparison": "equal",
  "value": 100,
  "alignment": 4,
  "maxCandidates": 5000
}
```

Replace the example address with an actual region from the target. Initial comparisons are `equal`, `not_equal`, `between` and `unknown`. `between` requires both `value` and `upperValue`.

4. Change the value through your test program's normal UI or test harness. Rescan using the returned `scanId` and `expectedRevision`:

```json
{
  "workspaceId": "your-workspace-id",
  "sessionId": "returned-session-uuid",
  "scanId": "returned-scan-uuid",
  "expectedRevision": 1,
  "comparison": "decreased"
}
```

Rescan comparisons additionally include `changed`, `unchanged`, `increased`, `decreased`, `increased_by` and `decreased_by`. Comparisons use the **previous successful scan baseline**, not a live watch or the original initial snapshot. A successful rescan advances the revision; a stale revision is rejected. An unreadable candidate is removed and explicitly counted. Incomplete coverage must not subsequently be interpreted as a whole-range negative result.

5. Page through `reverse_scan_results`, inspect the remaining addresses, and resolve known pointers where useful. Closing a scan frees a slot. Closing a session clears its baselines and receipts, but does not revert changes already made to the target.

Numeric types are signed/unsigned 8-, 16-, 32- and 64-bit integers, plus 32-/64-bit floats. **int64/uint64 values are decimal strings** in results and should be supplied as strings outside JavaScript's safe integer range. Floating comparisons support nonnegative absolute `epsilon`; non-finite values are not numeric scan candidates. Float search values are rounded to the selected storage type.

AoB patterns use space-separated byte tokens: `48 8B ?? A? ?F`. At least one nibble must be concrete. Results include overlapping matches. Alignment is relative to the absolute target address (file search uses absolute file offsets), not the beginning of a search window.

Scans read bounded chunks with overlap and rescan candidates in page-sized groups. They are observations of a changing process, **not an atomic snapshot**. Process identity prevents PID reuse from silently selecting a different process; it does not prove that an address still contains the same application object after reallocation.

### Continuation and completeness

A candidate cap or time budget returns `complete: false`, `stopReason` and `nextAddress`. Narrow the range or explicitly continue from that address with a recalculated remaining length. A continued initial scan creates another independent scan baseline; the plugin does not secretly merge truncated scans. Unreadable or filtered ranges are counted as skipped, so empty results do not falsely prove that no matching value exists.

Static searches and string extraction return `nextOffset`; binary-diff counts are explicitly page-local. Compare hashes across paginated file calls when the file may be changing.

### Pointer semantics

For `reverse_pointer_chain`, start at `address`. For each offset, read a pointer at the current address, then add the offset. A null pointer is rejected before adding the offset; a positive offset must not make a null pointee appear valid. Pointer width comes from the target process. The final address is returned without automatically modifying or dereferencing arbitrary data there.

`reverse_pointer_references` searches one supplied range for pointer words satisfying `pointer + offset = targetAddress`, with `0 <= offset <= maxOffset`. It is a one-level reference finder, **not** an exhaustive multi-level pointer scanner or a guarantee of stability after restart.

## Controlled modification

### Binary files

`reverse_patch_copy` defaults to `dryRun: true`. Supply the source SHA-256 and a list of `{offset, expectedHex, replacementHex}` patches. Actual creation requires `dryRun: false`, `confirm: true` and a new `outputPath` inside a writable workspace.

Patches must preserve length, must not overlap, and must match the supplied source bytes. The source is never overwritten. Existing output paths, including the source path, are refused. The output is flushed before success is reported. A write failure may leave a partial new output and reports that explicitly; the plugin does not delete a pathname that another actor could have replaced. This workflow does not recalculate application checksums or preserve signatures.

### Process memory

`allowMemoryWrite` defaults to **false**. Dry-run validation is available without enabling writes. To perform an intentional write, explicitly enable it through `plugin_configure`, then provide `dryRun: false`, `confirm: true`, the exact original bytes and equal-length replacement bytes.

Writes are limited to **1..256 bytes wholly inside one committed, private, writable, non-executable data region**. There is no page-protection change, privilege escalation, driver, remote thread, DLL injection, value freezing, anti-cheat bypass or DRM bypass. Operating-system access denial is returned, not bypassed.

The helper checks expected bytes, writes once, and reads back. Check `verified` and `bytesWritten`; a successful transport is not by itself evidence of a verified write. Read/check/write is **not atomic** and can race the application. Pause or coordinate your own test program when consistency matters. After timeout, partial write or verification failure, inspect memory before retrying.

A verified write returns a `writeId`; up to 16 receipts are kept per session in memory. `reverse_memory_restore` requires the current bytes still to match that receipt's replacement. It does not blindly restore over newer application changes. Receipts disappear on expiry, session close, plugin disable or Gateway restart; there is no automatic restoration when a session closes. Disable `allowMemoryWrite` again when the task is complete.

## Limits and lifecycle

| Resource | Limit |
|---|---:|
| File size | 64 MiB default; configurable 1..256 MiB |
| Simultaneous native helpers | 2; excess requests are rejected, not queued indefinitely |
| Native request / response | 2 MiB / 4 MiB |
| Native operation timeout | 15 seconds default; configurable 2..30 seconds |
| Numeric/AoB memory range per call | 64 MiB |
| Session count | 8 globally |
| Idle session lifetime | 15 minutes default; configurable 1..60 minutes |
| Scans / candidates | 4 scans per session; 5000 candidates per scan |
| Returned process AoB/pointer matches | Up to 500 per call |
| Hex / memory read | 16 KiB per call |
| Disassembly input | 8 KiB; up to 1000 instructions |
| Patch set | 128 non-overlapping patches; at most 64 KiB total replacement bytes |
| Memory write / receipts | 256 bytes per write; 16 receipts per session |

Operations on one session are serialized by rejection of concurrent requests, not by silent last-writer-wins updates. Busy sessions are not evicted by expiry cleanup. Disabling the plugin clears session state and stops active fixed helpers. There are no persistent debug attachments. Bounded session data is pruned lazily on subsequent registry access; no process handle remains open between native calls.

Audit records include operation, workspace, target PID and write verification status; native memory bytes and candidate baselines are not written into audit records. Fixed helpers use a shell-free, isolated interpreter and no workspace-controlled Python imports.

## Cancellation and revocation

Patch creation rechecks the current writable workspace, plugin enablement, request cancellation and resolved destination after its asynchronous intent audit and again before writing the opened file. Native helpers check current enablement and the request signal before launch, including after their intent audit. Cancellation of a running native helper requests termination and waits for its close event before rejecting; the abort listener is removed when the helper closes.

Cancellation is not rollback. A file already created can remain empty or partial if an operation is interrupted, and a target-memory write may already have happened. The original source file is never overwritten. Inspect the reported output or target before retrying an interrupted mutation. These checks do not make operating-system file access or process-memory writes atomic.

## Verification

The 2026-09-17 audit added `tests/reverse-audit.test.mjs`: interpreter-role validation; permission, plugin, workspace and cancellation changes during intent auditing; real helper cancellation/listener cleanup; 80 seeded differential scan cases against a bytewise oracle; and null-pointer-chain rejection. The changes preserve the existing 29-tool interface and defaults, without new backends or dependencies.

Focused checks:

```powershell
node --test tests/reverse-audit.test.mjs tests/reverse-core.test.mjs tests/reverse-engines.test.mjs tests/reverse-plugin.test.mjs tests/reverse-native.test.mjs tests/reverse-host-lifecycle.test.mjs
```

The tests cover numeric precision and overflow, PE/ELF structure bounds, wildcard/overlap/chunk-boundary searches, pagination, patch hash/byte conflicts, workspace/credential/reparse-point guards, serializable tool schemas, owner-only policy, session capacity/expiry/isolation, scan revision handling, permission revocation, and host disable/shutdown cleanup.

The actual bundled MCP HTTP transport is covered separately (build the Gateway first):

```powershell
node scripts/build-gateway.mjs
node --test tests/reverse-gateway.test.mjs
```

This test starts an isolated temporary Gateway and validates plugin enable/disable, discovery of all 29 tools, static binary inspection, numeric search, int64-safe codec output, and rejection of process access while disabled.

With Windows and a 64-bit Python interpreter, native integration tests create their **own disposable process** and exercise process identity, modules, regions, read, scan, rescan, pointer resolution, data-write verification and conflict-checked restoration. They do not operate on unrelated games or applications. Python-dependent tests are explicitly skipped when Python is unavailable; native Windows tests are skipped on other platforms. Optional Capstone disassembly is exercised only when that engine is present; absence is otherwise tested as an explicit diagnostic failure.

Also run the repository's `npm run check`, `npm run test:unit`, `npm run smoke:gateway` and `npm run package:vsix` before distribution. The Python helper is embedded as source text in JavaScript modules and therefore included in the Gateway bundle without an additional asset-copy step.

## API references

Implementation references: Microsoft Learn's PE Format specification, VirtualQueryEx, ReadProcessMemory, GetProcessTimes and the Capstone Python binding guide. These describe the external interfaces, not evidence that every format variation or instruction set has been validated by this plugin.

- https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
- https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-virtualqueryex
- https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-readprocessmemory
- https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes
- https://www.capstone-engine.org/lang_python.html
