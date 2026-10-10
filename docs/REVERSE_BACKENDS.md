# Installed reverse-engineering backends

The `reverse` engine can hand format parsing, code analysis and decompilation to tools installed on the owner's computer. DevMate finds them, starts them with fixed arguments on a private copy of the file, bounds the result and cleans up. It does not download or install anything, never executes the analyzed file, and has no decompiler of its own.

Starting an installed backend is available to the owner only. Other callers keep the built-in tools described in [REVERSE_ENGINEERING.md](REVERSE_ENGINEERING.md).

## Which backend does what

| Capability | Backend | Without it |
|---|---|---|
| `reverse.binary_info` | LIEF, or pefile for PE, or pyelftools for ELF | the limited built-in parser, labeled as a fallback |
| `reverse.disassemble` | Capstone | an error naming the missing package |
| `reverse.code_analyze` | Rizin, then radare2; Ghidra for `functions` and `xrefs` | an error listing what was looked for |
| `reverse.decompile` | Ghidra through PyGhidra 3+ | an error; no pseudocode is made up |

`reverse.toolchain` shows what was found and how to set each tool up. `probe: true` additionally imports the Python modules and asks the CLI tools for their version. Finding a tool or importing a module is not a test that analysis works.

`reverse.binary_info` takes `engine: auto | lief | pefile | pyelftools | builtin`. Results carry `backend.engine`, `backend.version`, `backend.fallback`, the source hash and diagnostics. With `allowBuiltinFallback: false`, auto mode fails instead of falling back. Data that is not a recognized executable is parsed by the built-in code without starting anything.

Backends report addresses differently: LIEF gives PE section addresses as RVAs, pefile gives preferred-image VAs and separately labeled export RVAs, pyelftools gives ELF section and segment VAs. None of them is a runtime, ASLR-adjusted address.

## Configuration

The owner sets paths with `capability.configure` (or `engineSettings.reverse` in `config.json`):

```json
{
  "engine": "reverse",
  "settings": {
    "pythonPath": "C:\\Tools\\reverse-env\\Scripts\\python.exe",
    "rizinPath": "C:\\Tools\\rizin\\bin\\rizin.exe",
    "ghidraInstallDir": "C:\\Tools\\ghidra",
    "analysisTimeoutMs": 120000
  }
}
```

- Paths are absolute. `pythonPath` must be a Python executable, `rizinPath` / `radare2Path` the matching CLI; shell scripts are refused. Without a configured path, `python`/`python3`, `rizin`, `radare2`/`r2` are looked up on `PATH`.
- Python packages (`lief`, `pefile`, `pyelftools`, `capstone`, `pyghidra`) must be installed into that interpreter. It runs in isolated mode, so project modules, `PYTHONPATH` and user-site packages are ignored. A dedicated virtual environment works well.
- `ghidraInstallDir` must contain `Ghidra/application.properties`. Ghidra 12+ with PyGhidra 3+ and a compatible JDK is expected.

## Workflow

1. `reverse.toolchain` with `{ "probe": true }`.
2. `reverse.binary_info` for the file; note the backend and the source hash.
3. `reverse.code_analyze` with `query: "functions"`. Queries: `functions`, `xrefs`, `symbols`, `imports`, `exports`, `sections`, `disassembly`. `xrefs` and `disassembly` need a hexadecimal `address`.
4. `reverse.decompile` with a function address.

`code_analyze` and `decompile` are flagged `longRunning`: start them with the `job.start` operation (see [CAPABILITIES.md](CAPABILITIES.md)).

Table queries page with `offset` and `limit` and return `nextOffset`. Disassembly pages by `nextAddress`. Integers beyond JavaScript's safe range arrive as decimal strings. There is no project cache: each call analyzes again, so narrow queries are faster. Decompiled C is an approximation, not the original source.

`analysisSeconds` and `decompileSeconds` are Ghidra's own budgets; `analysisTimeoutMs` (5 to 300 s, default 120 s) ends any backend process, including JVM start-up.

## Execution boundaries

- The file is read within the size limit, hashed and copied to a private temporary directory. Backends see the copy; neighbouring debug files and libraries are not provided. Temporary files and Ghidra projects are removed afterwards.
- Arguments are fixed and no shell is involved. Arbitrary backend commands, user scripts, debugger attach and write modes are not exposed. Rizin and radare2 run with `-NN` (no startup scripts or plugins), Python with `-I -B`.
- Backends get the allow-listed child environment with their home, configuration, cache and temp directories pointed at the temporary directory.
- At most two backend runs at a time. A response over 2 MiB or truncated output is rejected rather than parsed.
- Cancelling the call or job, switching the engine off, or closing the project stops the backend process tree.

These are limits on how DevMate starts the tools, not an operating-system sandbox: an installed backend is trusted local code. Analyze hostile files inside an isolated machine.

## Tests

`tests/reverse-engines.test.mjs` covers missing-backend diagnostics, the explicit fallback, command construction, numeric precision, response limits, cancellation and cleanup, using labeled stand-ins for the CLI tools. Tests that need real LIEF, pefile or pyelftools skip when the packages are absent. Nothing in the test suite runs a real Ghidra.

## Upstream references

- LIEF: https://lief.re/
- pefile: https://pefile.readthedocs.io/
- pyelftools: https://github.com/eliben/pyelftools
- Rizin: https://book.rizin.re/
- radare2: https://github.com/radareorg/radare2
- PyGhidra: https://github.com/NationalSecurityAgency/ghidra/blob/master/Ghidra/Features/PyGhidra/src/main/py/README.md
