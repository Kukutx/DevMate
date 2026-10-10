import fs from 'node:fs';
import path from 'node:path';
import { findOnPath } from './platform/tools.mjs';

// Windows PowerShell 5.1 reads a BOM-less script as ANSI and reports redirected
// errors as CLIXML for -EncodedCommand. A UTF-8 script file with a BOM gives
// plain-text errors, exact Unicode and no command-line quoting or length limit.
const POWERSHELL_PREFIX = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding\n";
// Report the last statement the way a POSIX shell would. PowerShell 5.1 sets $?
// to false when a native program merely wrote to a redirected stderr (git, npm
// and curl do this on success), so a zero native exit code with a
// NativeCommandError is success, not failure. The blank line keeps a trailing
// backtick in the command from swallowing this epilogue.
const POWERSHELL_SUFFIX = "\n\n$devmateOk = $?\nif ($devmateOk) { exit 0 }\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\n" +
  "if ($null -ne $LASTEXITCODE -and $Error.Count -gt 0 -and \"$($Error[0].FullyQualifiedErrorId)\" -like 'NativeCommandError*') { exit 0 }\nexit 1\n";

export function detectShell(env = process.env, platform = process.platform, { exists = file => !!fs.statSync(file, { throwIfNoEntry: false })?.isFile() } = {}) {
  if (platform !== 'win32') {
    // /bin/sh is dash on Debian and Ubuntu: `source`, `[[ ]]` and `set -o pipefail`, which models write by habit, fail there.
    const bash = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'].find(exists);
    return bash ? { kind: 'sh', file: bash, label: 'bash' } : { kind: 'sh', file: '/bin/sh', label: 'POSIX sh' };
  }
  const modern = findOnPath('pwsh', env);
  if (modern) return { kind: 'powershell', file: modern, label: 'PowerShell 7' };
  // Windows PowerShell 5.1 rejects `a && b`, which is what gets written by habit. Its error text is localized and
  // arrives in the console code page, so the plain statement of the cause is attached by DevMate (see processes.mjs).
  return { kind: 'powershell', label: 'Windows PowerShell 5.1', noChaining: true,
    file: path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') };
}

/**
 * Turn command text into an argv launch for the platform shell. The returned
 * cleanup removes the private script file; it is safe to call more than once.
 */
export function shellInvocation(command, { shell = detectShell(), scriptDirectory, id } = {}) {
  if (typeof command !== 'string' || !command.trim() || command.includes('\0')) throw new TypeError('command must be nonempty text');
  if (shell.kind === 'sh') return { file: shell.file, args: ['-c', command], cleanup() {} };
  if (!path.isAbsolute(scriptDirectory || '') || !/^[A-Za-z0-9_-]{1,80}$/.test(id || '')) throw new TypeError('A private script directory and id are required');
  fs.mkdirSync(scriptDirectory, { recursive: true, mode: 0o700 });
  const script = path.join(scriptDirectory, id + '.ps1');
  fs.writeFileSync(script, '\ufeff' + POWERSHELL_PREFIX + command + POWERSHELL_SUFFIX, { encoding: 'utf8', mode: 0o600 });
  return { file: shell.file, cleanup() { fs.rmSync(script, { force: true }); },
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] };
}
