// Thin adapters only: format parsing belongs to the installed upstream libraries.
export const PARSER_SOURCE = String.raw`
import sys, json, importlib, importlib.util, importlib.metadata, itertools, pathlib

MODULES = {'lief': 'lief', 'pefile': 'pefile', 'pyelftools': 'elftools', 'capstone': 'capstone', 'pyghidra': 'pyghidra'}

def module_info(engine):
    try:
        module = importlib.import_module(MODULES[engine])
        version = getattr(module, '__version__', None)
        if version is None:
            try: version = importlib.metadata.version(engine)
            except importlib.metadata.PackageNotFoundError: version = 'unknown'
        return {'available': True, 'version': str(version), 'verified': 'import only; not an analysis test'}
    except Exception as error:
        return {'available': False, 'error': str(error)[:1000], 'verified': 'import failed'}

def text(value):
    if value is None: return None
    if isinstance(value, bytes): value = value.decode('utf-8', 'replace')
    return str(value).rstrip('\x00')[:512]

def page(items, convert, limit):
    values = list(itertools.islice(items, limit + 1))
    return [convert(v) for v in values[:limit]], len(values) > limit

def lief_info(filename, limit):
    import lief
    binary = lief.parse(filename)
    if binary is None: raise ValueError('LIEF did not recognize this binary')
    abstract = binary.abstract
    result = {'format': str(binary.format).split('.')[-1], 'architecture': str(abstract.header.architecture),
              'entrypoint': hex(binary.entrypoint), 'imageBase': hex(binary.imagebase)}
    result['sections'], st = page(binary.sections, lambda s: {'name': text(s.name), 'offset': int(s.offset), 'size': int(s.size), 'virtualAddress': hex(s.virtual_address)}, limit)
    result['imports'], it = page(binary.imported_functions, lambda f: {'name': text(f.name), 'address': hex(f.address)}, limit)
    result['exports'], et = page(binary.exported_functions, lambda f: {'name': text(f.name), 'address': hex(f.address)}, limit)
    result['symbols'], yt = page(binary.symbols, lambda s: {'name': text(s.name), 'value': hex(s.value), 'size': int(s.size)}, limit)
    result['truncated'] = {'sections': st, 'imports': it, 'exports': et, 'symbols': yt}
    result['limitations'] = ['Unified metadata only; format-specific resources, signatures and debug data are not exported by this adapter']
    return result

def pefile_info(filename, limit):
    import pefile
    with pefile.PE(filename, fast_load=True, max_symbol_exports=limit + 1) as binary:
        binary.parse_data_directories(directories=[0, 1, 13])
        base = binary.OPTIONAL_HEADER.ImageBase
        result = {'format': 'PE', 'bits': 64 if binary.OPTIONAL_HEADER.Magic == 0x20b else 32,
                  'architecture': pefile.MACHINE_TYPE.get(binary.FILE_HEADER.Machine, str(binary.FILE_HEADER.Machine)),
                  'imageBase': hex(base), 'entrypoint': hex(base + binary.OPTIONAL_HEADER.AddressOfEntryPoint)}
        result['sections'], st = page(binary.sections, lambda s: {'name': text(s.Name), 'offset': s.PointerToRawData, 'size': s.SizeOfRawData, 'virtualAddress': hex(base + s.VirtualAddress), 'virtualSize': s.Misc_VirtualSize, 'flags': hex(s.Characteristics)}, limit)
        def imports():
            for attribute, delayed in [('DIRECTORY_ENTRY_IMPORT', False), ('DIRECTORY_ENTRY_DELAY_IMPORT', True)]:
                for library in getattr(binary, attribute, []):
                    for item in library.imports:
                        yield {'library': text(library.dll), 'name': text(item.name), 'ordinal': item.ordinal, 'address': hex(item.address), 'delayed': delayed}
        result['imports'], it = page(imports(), lambda x: x, limit)
        exports = getattr(getattr(binary, 'DIRECTORY_ENTRY_EXPORT', None), 'symbols', [])
        result['exports'], et = page(exports, lambda s: {'name': text(s.name), 'ordinal': s.ordinal, 'rva': hex(s.address), 'forwarder': text(s.forwarder)}, limit)
        result['truncated'] = {'sections': st, 'imports': it, 'exports': et}
        result['warnings'] = [text(w) for w in binary.get_warnings()[:20]]
        result['limitations'] = ['Exports are bounded while parsing; inspect warnings for malformed/truncated tables', 'Only normal and delay imports, exports and section metadata are exported']
        return result

def elf_info(filename, limit):
    from elftools.elf.elffile import ELFFile
    from elftools.elf.sections import SymbolTableSection
    with open(filename, 'rb') as stream:
        binary = ELFFile(stream)
        result = {'format': 'ELF', 'bits': binary.elfclass, 'endian': 'little' if binary.little_endian else 'big',
                  'architecture': binary['e_machine'], 'entrypoint': hex(binary['e_entry'])}
        result['sections'], st = page(binary.iter_sections(), lambda s: {'name': text(s.name), 'offset': s['sh_offset'], 'size': s['sh_size'], 'virtualAddress': hex(s['sh_addr']), 'type': str(s['sh_type'])}, limit)
        result['segments'], pt = page(binary.iter_segments(), lambda s: {'type': str(s['p_type']), 'offset': s['p_offset'], 'fileSize': s['p_filesz'], 'memorySize': s['p_memsz'], 'virtualAddress': hex(s['p_vaddr']), 'flags': s['p_flags']}, limit)
        def symbols():
            for section in binary.iter_sections():
                if isinstance(section, SymbolTableSection):
                    for s in section.iter_symbols():
                        yield {'name': text(s.name), 'value': hex(s['st_value']), 'size': s['st_size'], 'type': str(s['st_info']['type']), 'binding': str(s['st_info']['bind']), 'section': str(s['st_shndx']), 'table': text(section.name)}
        result['symbols'], yt = page(symbols(), lambda x: x, limit)
        result['truncated'] = {'sections': st, 'segments': pt, 'symbols': yt}
        result['limitations'] = ['Symbol tables are not a complete dynamic-linker import/export model; DWARF data is not exported']
        return result

def inspect_binary(request):
    filename, limit = request['input'], request['limit']
    with open(filename, 'rb') as stream: magic = stream.read(4)
    candidates = ['lief'] + (['pefile'] if magic[:2] == b'MZ' else ['pyelftools'] if magic == b'\x7fELF' else [])
    requested = request.get('engine', 'auto')
    if requested != 'auto': candidates = [requested]
    diagnostics = []
    for engine in candidates:
        info = module_info(engine)
        if not info['available']:
            diagnostics.append({'engine': engine, **info})
            continue
        # A parse failure is an analysis error, not proof that a dependency is absent.
        # Do not disguise it as a successful result from the limited fallback parser.
        try: result = {'lief': lief_info, 'pefile': pefile_info, 'pyelftools': elf_info}[engine](filename, limit)
        except Exception as error: raise RuntimeError(engine + ' analysis failed: ' + str(error)) from error
        return {'available': True, 'backend': {'engine': engine, 'version': info['version'], 'fallback': False}, 'diagnostics': diagnostics, **result}
    return {'available': False, 'diagnostics': diagnostics, 'reason': 'No usable requested parser; install a listed optional package into the configured isolated Python environment'}
`;
