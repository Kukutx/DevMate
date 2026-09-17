// Fixed Python helper source, bundled as text: no workspace scripts or user code.
export const WINDOWS_SOURCE = String.raw`
import ctypes as C
from ctypes import wintypes as W
from contextlib import contextmanager

if sys.platform == 'win32':
    K = C.WinDLL('kernel32', use_last_error=True)
    def api(name, result, *args):
        fn = getattr(K, name)
        fn.restype, fn.argtypes = result, list(args)
        return fn
    class MBI(C.Structure):
        _fields_ = [('BaseAddress', C.c_void_p), ('AllocationBase', C.c_void_p), ('AllocationProtect', W.DWORD), ('PartitionId', W.WORD), ('RegionSize', C.c_size_t), ('State', W.DWORD), ('Protect', W.DWORD), ('Type', W.DWORD)]
    class PROCESS(C.Structure):
        _fields_ = [('dwSize', W.DWORD), ('cntUsage', W.DWORD), ('pid', W.DWORD), ('heap', C.c_size_t), ('module', W.DWORD), ('threads', W.DWORD), ('parentPid', W.DWORD), ('priority', W.LONG), ('flags', W.DWORD), ('name', W.WCHAR * 260)]
    class MODULE(C.Structure):
        _fields_ = [('dwSize', W.DWORD), ('module', W.DWORD), ('pid', W.DWORD), ('globalUsage', W.DWORD), ('processUsage', W.DWORD), ('base', C.c_void_p), ('size', W.DWORD), ('handle', W.HMODULE), ('name', W.WCHAR * 256), ('path', W.WCHAR * 260)]
    Open = api('OpenProcess', W.HANDLE, W.DWORD, W.BOOL, W.DWORD)
    Close = api('CloseHandle', W.BOOL, W.HANDLE)
    Times = api('GetProcessTimes', W.BOOL, W.HANDLE, C.POINTER(W.FILETIME), C.POINTER(W.FILETIME), C.POINTER(W.FILETIME), C.POINTER(W.FILETIME))
    Image = api('QueryFullProcessImageNameW', W.BOOL, W.HANDLE, W.DWORD, W.LPWSTR, C.POINTER(W.DWORD))
    Wow = api('IsWow64Process', W.BOOL, W.HANDLE, C.POINTER(W.BOOL))
    ExitCode = api('GetExitCodeProcess', W.BOOL, W.HANDLE, C.POINTER(W.DWORD))
    Query = api('VirtualQueryEx', C.c_size_t, W.HANDLE, C.c_void_p, C.POINTER(MBI), C.c_size_t)
    Read = api('ReadProcessMemory', W.BOOL, W.HANDLE, C.c_void_p, C.c_void_p, C.c_size_t, C.POINTER(C.c_size_t))
    Write = api('WriteProcessMemory', W.BOOL, W.HANDLE, C.c_void_p, C.c_void_p, C.c_size_t, C.POINTER(C.c_size_t))
    Snapshot = api('CreateToolhelp32Snapshot', W.HANDLE, W.DWORD, W.DWORD)
    ProcessFirst = api('Process32FirstW', W.BOOL, W.HANDLE, C.POINTER(PROCESS))
    ProcessNext = api('Process32NextW', W.BOOL, W.HANDLE, C.POINTER(PROCESS))
    ModuleFirst = api('Module32FirstW', W.BOOL, W.HANDLE, C.POINTER(MODULE))
    ModuleNext = api('Module32NextW', W.BOOL, W.HANDLE, C.POINTER(MODULE))

def windows_required():
    if sys.platform != 'win32' or struct.calcsize('P') != 8:
        raise ValueError('Process memory requires Windows and 64-bit Python')

def failure(label):
    code = C.get_last_error()
    raise OSError(code, label + ': ' + C.FormatError(code).strip())

def process_info(handle, pid):
    times = [W.FILETIME() for _ in range(4)]
    if not Times(handle, *[C.byref(t) for t in times]): failure('GetProcessTimes')
    creation = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
    code, wow = W.DWORD(), W.BOOL()
    if not ExitCode(handle, C.byref(code)): failure('GetExitCodeProcess')
    if code.value != 259: raise ValueError('Target process has exited')
    if not Wow(handle, C.byref(wow)): failure('IsWow64Process')
    name, length = C.create_unicode_buffer(32768), W.DWORD(32768)
    if not Image(handle, 0, name, C.byref(length)): failure('QueryFullProcessImageNameW')
    return {'pid': pid, 'creationTime': str(creation), 'imagePath': name.value, 'pointerSize': 4 if wow.value else 8}

@contextmanager
def opened(request, write=False):
    windows_required()
    pid = int(request['pid'])
    if pid <= 4 or pid > 0xffffffff: raise ValueError('Invalid target PID')
    rights = 0x400 | 0x10 | ((0x20 | 0x8) if write else 0)
    handle = Open(rights, False, pid)
    if not handle: failure('OpenProcess')
    try:
        identity = process_info(handle, pid)
        expected = request.get('identity')
        if expected and (str(expected['creationTime']) != identity['creationTime'] or expected['imagePath'] != identity['imagePath']):
            raise ValueError('Target identity changed (PID reused); open a new session')
        yield handle, identity
    finally:
        Close(handle)

def memory_region(handle, address):
    info = MBI()
    if not Query(handle, address, C.byref(info), C.sizeof(info)): failure('VirtualQueryEx')
    base = int(info.BaseAddress or 0)
    if info.RegionSize <= 0 or base + info.RegionSize <= address: raise ValueError('Invalid virtual memory region')
    protection = info.Protect & 0xff
    readable = info.State == 0x1000 and not info.Protect & 0x100 and protection in (2, 4, 8, 0x20, 0x40, 0x80)
    return {'base': base, 'size': int(info.RegionSize), 'state': info.State, 'protection': info.Protect, 'type': info.Type, 'readable': bool(readable), 'writable': bool(readable and protection in (4, 8, 0x40, 0x80)), 'executable': bool(protection & 0xf0)}

def read_raw(handle, address, size):
    if size < 1 or size > 1024 * 1024: raise ValueError('Read size outside bounds')
    cursor = address
    while cursor < address + size:
        region = memory_region(handle, cursor)
        if not region['readable']: raise ValueError('Memory is not readable (uncommitted, guarded or no-access)')
        cursor = min(address + size, region['base'] + region['size'])
    data, count = C.create_string_buffer(size), C.c_size_t()
    if not Read(handle, address, data, size, C.byref(count)) or count.value != size: failure('ReadProcessMemory')
    return data.raw

def list_processes(request):
    windows_required()
    handle = Snapshot(2, 0)
    if handle == C.c_void_p(-1).value: failure('Process snapshot')
    entries = []
    try:
        item = PROCESS(); item.dwSize = C.sizeof(item)
        ok = ProcessFirst(handle, C.byref(item))
        while ok:
            if not request.get('name') or request['name'].casefold() in item.name.casefold():
                entries.append({'pid': item.pid, 'parentPid': item.parentPid, 'name': item.name, 'threads': item.threads})
            ok = ProcessNext(handle, C.byref(item))
        if C.get_last_error() != 18: failure('Process enumeration')
    finally: Close(handle)
    entries.sort(key=lambda value: value['pid'])
    offset, limit = request.get('offset', 0), request.get('limit', 200)
    return {'entries': entries[offset:offset + limit], 'total': len(entries), 'nextOffset': offset + limit if len(entries) > offset + limit else None}

def list_modules(request, handle):
    snap = Snapshot(8 | 0x10, int(request['pid']))
    if snap == C.c_void_p(-1).value: failure('Module snapshot')
    entries = []
    try:
        item = MODULE(); item.dwSize = C.sizeof(item)
        ok = ModuleFirst(snap, C.byref(item))
        while ok:
            entries.append({'name': item.name, 'path': item.path, 'base': hex(item.base or 0), 'size': item.size})
            if len(entries) > 16384: raise ValueError('Module count exceeds limit')
            ok = ModuleNext(snap, C.byref(item))
        if C.get_last_error() != 18: failure('Module enumeration')
        # The snapshot is PID-based; recheck the held process after enumeration.
        process_info(handle, request['pid'])
    finally: Close(snap)
    offset, limit = request.get('offset', 0), request.get('limit', 200)
    return {'entries': entries[offset:offset + limit], 'total': len(entries), 'nextOffset': offset + limit if len(entries) > offset + limit else None}

def list_regions(request, handle, identity):
    address = int(request.get('address', '0x0'), 0)
    end = (1 << (identity['pointerSize'] * 8)) - 1
    entries, visited = [], 0
    while address < end and len(entries) < request.get('limit', 200):
        if visited >= 65536: raise ValueError('Region enumeration budget exceeded; use a narrower starting address')
        visited += 1
        try: region = memory_region(handle, address)
        except OSError as error:
            if error.errno == 87: return {'entries': entries, 'nextAddress': None}
            raise
        address = region['base'] + region['size']
        if not request.get('readableOnly', True) or region['readable']:
            entries.append({**region, 'base': hex(region['base'])})
    return {'entries': entries, 'nextAddress': hex(address) if address < end else None}

def write_memory(request, handle):
    address = int(request['address'], 0)
    expected, replacement = bytes.fromhex(request['expectedHex']), bytes.fromhex(request['replacementHex'])
    if not 1 <= len(expected) <= 256 or len(expected) != len(replacement): raise ValueError('Write requires 1..256 equal-length expected/replacement bytes')
    region = memory_region(handle, address)
    if not region['writable'] or region['executable'] or region['type'] != 0x20000 or address + len(expected) > region['base'] + region['size']:
        raise ValueError('Writes are limited to one committed, private, writable, non-executable data region')
    before = read_raw(handle, address, len(expected))
    if before != expected: raise ValueError('Expected bytes mismatch; target changed, no write performed')
    if request.get('dryRun', True): return {'dryRun': True, 'address': hex(address), 'length': len(before), 'expectedMatched': True}
    if request.get('confirm') is not True: raise ValueError('Write requires confirm=true')
    count, data = C.c_size_t(), C.create_string_buffer(replacement, len(replacement))
    ok = Write(handle, address, data, len(replacement), C.byref(count))
    error_code = C.get_last_error() if not ok else None
    try: after = read_raw(handle, address, len(replacement)).hex()
    except (OSError, ValueError): after = None
    return {'dryRun': False, 'address': hex(address), 'bytesWritten': count.value, 'verified': bool(ok and count.value == len(replacement) and after == replacement.hex()), 'originalHex': before.hex(), 'replacementHex': replacement.hex(), 'observedHex': after, 'win32Error': error_code, 'atomic': False}

def pointer_chain(request, handle, identity):
    address = int(request['address'], 0)
    width = identity['pointerSize']
    chain = []
    for offset in request['offsets']:
        pointer = int.from_bytes(read_raw(handle, address, width), 'little')
        if pointer == 0: raise ValueError('Null pointer in chain')
        next_address = pointer + int(offset)
        if not 0 < next_address < (1 << (width * 8)): raise ValueError('Null, overflowed or invalid pointer')
        chain.append({'address': hex(address), 'pointer': hex(pointer), 'offset': str(offset), 'nextAddress': hex(next_address)})
        address = next_address
    return {'chain': chain, 'finalAddress': hex(address), 'pointerSize': width}
`;
