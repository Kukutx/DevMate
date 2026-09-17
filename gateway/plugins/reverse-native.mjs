import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { requestSignal } from '../request-context.mjs';
import { WINDOWS_SOURCE } from './reverse-windows-source.mjs';
import { SCANNER_SOURCE } from './reverse-scanner-source.mjs';

const PREAMBLE = 'import sys, json, struct, math, re, time, importlib.util\n';
const MAIN_SOURCE = String.raw`
def dispatch(request):
    operation = request['operation']
    if operation == 'status':
        available = importlib.util.find_spec('capstone') is not None
        return {'platform': sys.platform, 'pythonVersion': sys.version.split()[0], 'pointerSize': struct.calcsize('P'), 'processMemory': sys.platform == 'win32' and struct.calcsize('P') == 8, 'capstoneAvailable': available}
    if operation == 'disassemble':
        import capstone as cs
        architectures = {'x86': (cs.CS_ARCH_X86, cs.CS_MODE_32), 'x86_64': (cs.CS_ARCH_X86, cs.CS_MODE_64), 'arm': (cs.CS_ARCH_ARM, cs.CS_MODE_ARM), 'thumb': (cs.CS_ARCH_ARM, cs.CS_MODE_THUMB)}
        if request['architecture'] == 'arm64':
            architecture, mode = getattr(cs, 'CS_ARCH_AARCH64', None) or getattr(cs, 'CS_ARCH_ARM64'), 0
        else: architecture, mode = architectures[request['architecture']]
        if request.get('endian', 'little') == 'big':
            if request['architecture'].startswith('x86'): raise ValueError('x86 is little endian')
            mode |= cs.CS_MODE_BIG_ENDIAN
        engine = cs.Cs(architecture, mode)
        data, address = bytes.fromhex(request['hex']), int(request['address'], 0)
        if not 1 <= len(data) <= 8192 or not 1 <= request.get('count', 200) <= 1000: raise ValueError('Disassembly bounds exceeded')
        instructions = []
        consumed = 0
        for at, size, mnemonic, operands in engine.disasm_lite(data, address, request.get('count', 200)):
            instructions.append({'address': hex(at), 'size': size, 'hex': data[consumed:consumed + size].hex(), 'mnemonic': mnemonic, 'operands': operands})
            consumed += size
        return {'engine': 'capstone', 'version': cs.__version__, 'instructions': instructions, 'bytesConsumed': consumed, 'remainingBytes': len(data) - consumed, 'nextAddress': hex(address + consumed)}
    if operation == 'processes': return list_processes(request)
    with opened(request, operation == 'write' and request.get('dryRun', True) is False) as pair:
        handle, identity = pair
        if operation == 'identity': return identity
        if operation == 'modules': return list_modules(request, handle)
        if operation == 'regions': return list_regions(request, handle, identity)
        if operation == 'read':
            data = read_raw(handle, int(request['address'], 0), int(request['length']))
            return {'address': request['address'], 'length': len(data), 'hex': data.hex()}
        if operation == 'write': return write_memory(request, handle)
        if operation == 'scan': return scan_memory(request, handle, identity)
        if operation == 'search': return scan_memory(request, handle, identity, True)
        if operation == 'rescan': return rescan_memory(request, handle)
        if operation == 'pointer_chain': return pointer_chain(request, handle, identity)
        raise ValueError('Unknown operation')

if __name__ == '__main__':
    try:
        text = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(text) > 2 * 1024 * 1024: raise ValueError('Input limit exceeded')
        result = dispatch(json.loads(text))
        print(json.dumps({'ok': True, 'result': result}, allow_nan=False, ensure_ascii=True))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': {'type': type(error).__name__, 'message': str(error), 'code': getattr(error, 'errno', None)}}, ensure_ascii=True))
`;
export const PYTHON_SOURCE = PREAMBLE + WINDOWS_SOURCE + SCANNER_SOURCE + MAIN_SOURCE;
const OPERATIONS = new Set(['status', 'disassemble', 'processes', 'identity', 'modules', 'regions', 'read', 'write', 'scan', 'search', 'rescan', 'pointer_chain']);
const children = new Set();
let pending = 0;
let nativeGeneration = 0;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function pythonExecutable(context) {
  const configured = context.settings.pythonPath;
  if (configured && !path.isAbsolute(configured)) throw new Error('pythonPath must be an absolute Python executable path');
  const executable = context.executables.find(configured ? [configured] : ['python', 'python3']);
  if (!executable) throw new Error('Python was not found. Configure pythonPath for devmate.reverse; nothing is installed automatically.');
  // The plugin also permits CLI engines; that union is not an interpreter check.
  if (!/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(path.basename(executable))) throw new Error('Expected a native Python executable, not a different backend or shell wrapper');
  context.executables.assertAllowed(executable);
  return executable;
}

export async function runNative(context, operation, payload = {}) {
  if (!OPERATIONS.has(operation)) throw new Error('Unsupported native operation');
  const signal = requestSignal();
  const assertAccess = () => {
    signal?.throwIfAborted();
    context.assertCanMutate('Running the fixed reverse-analysis helper');
    if (context.permissionProfile() !== 'fullAccess') throw new Error('Native reverse analysis requires fullAccess');
    if (context.readConfig && !context.readConfig().plugins?.enabled?.includes('devmate.reverse')) throw new Error('Reverse plugin is disabled');
    if (!['status', 'disassemble'].includes(operation) && !context.settings.allowProcessAccess) throw new Error('Process access was disabled before helper execution');
    if (operation === 'write' && payload.dryRun === false && !context.settings.allowMemoryWrite) throw new Error('Memory writes were disabled before helper execution');
  };
  assertAccess();
  if (pending >= 2) throw new Error('Reverse helper capacity reached (2 concurrent operations); retry after an operation finishes');
  const executable = pythonExecutable(context);
  const input = JSON.stringify({ ...payload, operation, budgetMs: Math.max(100, context.settings.nativeTimeoutMs - 1000) });
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error('Reverse helper input exceeds 2 MiB');
  const generation = nativeGeneration;
  pending++;
  try {
    await context.audit('native_intent', { operation, workspace: payload.workspaceId, pid: payload.pid });
    if (generation !== nativeGeneration) throw new Error('Reverse plugin stopped while scheduling the helper');
    assertAccess();
    const result = await new Promise((resolve, reject) => {
      // No shell, workspace imports, external scripts, downloads, or privilege elevation.
      const child = spawn(executable, ['-I', '-B', '-u', '-c', PYTHON_SOURCE], { cwd: os.tmpdir(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      children.add(child);
      const stdout = [], stderr = [];
      let size = 0, errorSize = 0, failure = null;
      const stop = error => { failure ||= error; child.kill('SIGKILL'); };
      const onAbort = () => stop(new Error('Reverse helper cancelled; inspect the target before retrying a write', { cause: signal.reason }));
      const timer = setTimeout(() => stop(new Error('Reverse helper timed out; inspect the target before retrying a write')), context.settings.nativeTimeoutMs);
      timer.unref();
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', data => {
        size += data.length;
        if (size > MAX_OUTPUT_BYTES) stop(new Error('Reverse helper output exceeds 4 MiB'));
        else stdout.push(data);
      });
      child.stderr.on('data', data => { if (errorSize < 8192) stderr.push(data.subarray(0, 8192 - errorSize)); errorSize += data.length; });
      child.on('error', error => { failure ||= error; });
      child.stdin.on('error', error => { failure ||= error; });
      child.on('close', code => {
        clearTimeout(timer); children.delete(child);
        signal?.removeEventListener('abort', onAbort);
        if (failure) return reject(failure);
        if (code !== 0) return reject(new Error(`Reverse helper exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
        try {
          const response = JSON.parse(Buffer.concat(stdout).toString('utf8'));
          if (response.ok !== true) throw new Error(`Reverse helper: ${response.error?.message || 'invalid response'}`);
          if (!response.result || typeof response.result !== 'object') throw new Error('Invalid reverse helper result');
          resolve(response.result);
        } catch (error) { reject(error); }
      });
      if (signal?.aborted) onAbort();
      child.stdin.end(input, 'utf8');
    });
    await context.audit('native_complete', { operation, workspace: payload.workspaceId, pid: payload.pid, verified: result.verified });
    signal?.throwIfAborted();
    return result;
  } finally { pending--; }
}

export async function stopNativeHelpers() {
  nativeGeneration++;
  await Promise.all([...children].map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('close', resolve);
    child.kill('SIGKILL');
  })));
}

export const __test = { OPERATIONS, MAX_OUTPUT_BYTES, activeCount: () => pending };
