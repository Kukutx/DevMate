const WINDOWS_COMMAND_SHIMS = new Set(['npm', 'pnpm', 'yarn']);
const SUPPORTED_PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9_.@][A-Za-z0-9_.:@/-]{0,199}$/;

function normalizePackageManager(packageManager) {
  const value = String(packageManager || '').trim().toLowerCase();
  if (!SUPPORTED_PACKAGE_MANAGERS.has(value)) throw new Error(`Unsupported package manager: ${value || '(empty)'}`);
  return value;
}

export function assertPackageScriptIdentifier(script) {
  const value = String(script || '');
  if (!SAFE_SCRIPT_NAME.test(value)) {
    throw new Error('Project script name must be a single option-safe package script identifier');
  }
  return value;
}

export function packageManagerInvocation(packageManager, args = [], options = {}) {
  const value = normalizePackageManager(packageManager);
  const platform = options.platform || process.platform;
  const argv = args.map(argument => String(argument));
  if (platform === 'win32' && WINDOWS_COMMAND_SHIMS.has(value)) {
    return {
      command: options.comspec || process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `${value}.cmd`, ...argv]
    };
  }
  return { command: value, args: argv };
}
