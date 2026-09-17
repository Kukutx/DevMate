# Mature reverse-engineering backends

`devmate.reverse` 0.2.0 delegates format parsing, code analysis and decompilation to installed upstream tools. DevMate owns discovery, bounded invocation, workspace checks, result metadata and cleanup. It does not download tools, install packages, execute the analyzed sample, or implement a replacement decompiler.

## Backend selection

| Operation | Preferred backend | Alternative / absence behavior |
|---|---|---|
| `reverse_binary_info` | LIEF | pefile for PE, pyelftools for ELF; a limited built-in fallback is explicitly labeled |
| `reverse_disassemble` | Capstone | Missing package is an error; file-based disassembly can instead use `reverse_code_analyze` with an installed CLI engine |
| `reverse_code_analyze` | Rizin, then radare2 | Ghidra for functions/xrefs when CLI executables are absent; no invented function or reference data |
| `reverse_decompile` | Ghidra through PyGhidra 3+ | Missing Ghidra, Python, PyGhidra or compatible JDK is reported; there is no synthetic decompiler fallback |

`reverse_toolchain` provides discovery and setup guidance. `probe: false` only locates executables/configuration. `probe: true` imports Python modules and checks CLI versions. **Finding an executable or importing a module is not an end-to-end analysis test.** Ghidra installation discovery checks the configured directory; it does not certify JVM startup or decompiler compatibility.

`reverse_binary_info` accepts `engine: auto | lief | pefile | pyelftools | builtin`. Auto follows the above order. Installed-parser failures are reported instead of being disguised as successful built-in parsing. Results include `backend.engine`, `backend.version`, `backend.fallback`, source hash and diagnostics. Set `allowBuiltinFallback: false` to require a mature parser; explicitly selecting `builtin` remains possible. Raw/unrecognized data normally uses the byte-oriented built-in tools rather than being passed to an executable-format parser.

Backend result fields are not identical. LIEF exposes unified metadata and backend-native address semantics: in particular, PE section `virtualAddress` values are RVAs, not runtime ASLR-adjusted addresses. Its import/export function addresses are also upstream metadata, not guaranteed live call targets. pefile returns preferred-image section VAs and separately labeled export RVAs. pyelftools returns ELF section/segment VAs and symbol-table entries, not a complete dynamic-linker import/export model. LIEF Mach-O handling uses its generic parser selection; the adapter does not expose universal-binary slice selection. None of these adapters exports the entire upstream API.

## Configure installed tools

Use `plugin_configure`; do not edit global configuration files directly. An example, with paths replaced by actual installed locations:

```json
{
  "id": "devmate.reverse",
  "settings": {
    "pythonPath": "C:\\Tools\\reverse-env\\Scripts\\python.exe",
    "rizinPath": "C:\\Tools\\rizin\\bin\\rizin.exe",
    "radare2Path": "",
    "ghidraInstallDir": "C:\\Tools\\ghidra",
    "binaryEngine": "auto",
    "allowBuiltinFallback": true,
    "analysisTimeoutMs": 120000
  }
}
```

All packages must be installed into the interpreter selected by `pythonPath`. Isolated Python mode intentionally ignores workspace modules, `PYTHONPATH` and user-site packages. A dedicated virtual environment is suitable. Optional package names are `lief`, `pefile`, `pyelftools`, `capstone` and `pyghidra`; nothing in DevMate installs them. Obtain CLI executables and Ghidra from their official projects. Do not configure shell scripts, command strings or user-supplied analysis scripts as executable paths.

PyGhidra 3+ uses the current project API (`open_project`, `program_loader`, `program_context`, `analyze` and `task_monitor`) with Ghidra 12+. The adapter does not build a new dependency on deprecated `open_program()`. Java compatibility is governed by the installed Ghidra release. Ghidra is deliberately selected by explicit `ghidraInstallDir`, rather than by a last-used GUI project or unrelated user preferences.

## Agent workflow

1. Call `reverse_toolchain` with `{"probe":true}`. Distinguish missing packages, invalid configuration and probe evidence.
2. Call `reverse_binary_info` for the authorized workspace binary. Inspect the backend/fallback fields and record the source hash.
3. Call `reverse_code_analyze` with `query: "functions"`. Supported CLI queries are `functions`, `xrefs`, `symbols`, `imports`, `exports`, `sections` and `disassembly`.
4. Supply a hexadecimal `address` for `xrefs` or `disassembly`. Use returned function addresses with `reverse_decompile`. Ghidra addresses are explicitly prefixed with `0x`.
5. Compare source hashes across calls. Decompiled C is an approximation, not original source or proof of behavioral equivalence.

Table queries accept `offset` and `limit`, with `nextOffset` and a page-completion indicator. CLI table results retain upstream fields; 64-bit integer values outside the JavaScript safe range become decimal strings rather than rounded numbers. JSON with unsupported/ambiguous unsafe numeric forms is rejected. Disassembly uses an instruction count and `nextAddress`; it does not use table-offset pagination, and completing a requested instruction window does not mean the whole binary was disassembled.

`analysisSeconds` is a Ghidra analysis/monitor budget; `decompileSeconds` bounds one decompile operation. The outer `analysisTimeoutMs` applies to each external command and can terminate work earlier, including JVM startup. CLI function/xref discovery currently performs `aaa` on each request; other queries do not automatically perform full analysis. There is no persistent project cache. Repeated pagination may repeat upstream analysis; narrow queries and use reasonable page sizes. This first adapter release does not claim optimized persistent-session performance.

## Execution boundaries

External analysis requires owner authority and `fullAccess`. Workspace containment remains in force; in `fullAccess`, trusted local plugin file paths use the same credential/secret-path bypass as the rest of DevMate's local development workflow. Process-memory access and writes retain their separate opt-in settings and are not enabled by these backends.

The adapter reads a bounded workspace file, records its SHA-256 and creates a private temporary copy with a fixed filename. Upstream parsers see that copy, not the user's source path. Ghidra projects are temporary. Inputs, projects and results are removed on completion/failure. Source files are never rewritten by these analysis tools. Copy-only input also means neighboring debug files and dependent libraries are not automatically supplied.

CLI arguments are fixed and shell-free. No arbitrary `-c` text, user scripts, debugger attach, write mode or sample execution is exposed. Rizin/radare2 use `-NN` to disable startup scripts/plugins. Python uses `-I -B`; external processes receive a small environment allowlist and temporary home/config/cache directories instead of credentials and runtime-injection variables. The runtime reuses DevMate's shared command execution, cancellation and process-tree termination rather than introducing another process supervisor.

These are invocation and data-boundary safeguards, **not an operating-system sandbox**. Installed backends and their native libraries remain trusted local code. There is no hard per-process RAM/disk quota or OS network sandbox. Analyze hostile samples inside an appropriately isolated operating-system environment.

## Bounds and validation

External analysis has a separate two-operation concurrency cap. File-size limits remain those of the reverse plugin. Responses are limited to 2 MiB; oversized/truncated CLI output is rejected rather than parsed as a complete result. Ghidra decompiled text has an explicit character limit and truncation flag. Outer command timeouts default to 120 seconds and are configurable from 5 to 300 seconds. Plugin disable/shutdown cancels registered external operations and clears temporary state.

Run:

```powershell
node scripts/build-gateway.mjs
node --test tests/reverse-core.test.mjs tests/reverse-engines.test.mjs tests/reverse-plugin.test.mjs tests/reverse-native.test.mjs tests/reverse-host-lifecycle.test.mjs tests/reverse-gateway.test.mjs
```

The suite covers missing-engine diagnostics, explicit fallback, command construction, output precision, response limits, cancellation, temporary cleanup and owner/workspace boundaries. CLI contract tests use labeled test doubles. Optional real LIEF/pefile/pyelftools tests skip when packages or matching fixtures are absent. Ghidra address formatting and bridge syntax are tested separately; these tests are not a substitute for running an installed Ghidra distribution. Report skipped/absent-engine coverage alongside passing tests.

## Upstream references

- LIEF: https://lief.re/
- pefile API: https://pefile.readthedocs.io/en/latest/modules/pefile.html
- pyelftools: https://github.com/eliben/pyelftools
- Rizin CLI: https://book.rizin.re/src/first_steps/commandline_options.html
- Rizin analysis: https://book.rizin.re/src/analysis/code_analysis.html
- radare2: https://github.com/radareorg/radare2
- PyGhidra API: https://github.com/NationalSecurityAgency/ghidra/blob/master/Ghidra/Features/PyGhidra/src/main/py/README.md
- Ghidra decompiler API: https://ghidra.re/ghidra_docs/api/ghidra/app/decompiler/DecompInterface.html
