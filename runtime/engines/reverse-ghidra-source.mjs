// Uses the current PyGhidra project API and Ghidra's decompiler, not a custom engine.
export const GHIDRA_SOURCE = String.raw`
def ghidra_address(address):
    # Ghidra's default display omits 0x; never send that ambiguous text to agents.
    return hex(int(address.getOffset()) & ((1 << 64) - 1))

def ghidra_query(request):
    try: import pyghidra as pg
    except ImportError as error:
        raise RuntimeError('PyGhidra is unavailable in the configured Python; install PyGhidra 3+ and configure Ghidra with a compatible JDK') from error
    required = ['open_project', 'program_loader', 'program_context', 'analyze', 'task_monitor']
    missing = [name for name in required if not hasattr(pg, name)]
    if missing: raise RuntimeError('PyGhidra 3+ API required; missing ' + ', '.join(missing))
    install_dir = request.get('ghidraInstallDir')
    if not install_dir: raise RuntimeError('Configure ghidraInstallDir to an installed Ghidra distribution')
    pg.start(install_dir=pathlib.Path(install_dir))
    from ghidra.framework import Application
    from ghidra.app.decompiler import DecompInterface
    monitor = pg.task_monitor(request.get('analysisSeconds', 60))
    backend = {'engine': 'ghidra', 'version': str(Application.getApplicationVersion()), 'bridgeVersion': module_info('pyghidra')['version'], 'fallback': False}
    with pg.open_project(request['scratch'], 'analysis', create=True) as project:
        loader = pg.program_loader().project(project).source(request['input']).name('sample')
        with loader.load() as loaded:
            loaded.save(monitor)
        with pg.program_context(project, '/sample') as program:
            log = str(pg.analyze(program, monitor))
            if monitor.isCancelled(): raise TimeoutError('Ghidra analysis was cancelled; results are incomplete')
            manager = program.getFunctionManager()
            common = {'backend': backend, 'language': str(program.getLanguageID()), 'imageBase': ghidra_address(program.getImageBase()), 'analysisLog': log[:4000], 'analysisLogTruncated': len(log) > 4000}
            operation = request['operation']
            if operation == 'functions':
                iterator = manager.getFunctions(True)
                offset, limit, index, items = request.get('offset', 0), request['limit'], 0, []
                while iterator.hasNext() and index < offset:
                    monitor.checkCancelled()
                    iterator.next(); index += 1
                while iterator.hasNext() and len(items) < limit:
                    monitor.checkCancelled()
                    f = iterator.next()
                    items.append({'name': text(f.getName()), 'address': ghidra_address(f.getEntryPoint()), 'addressSpace': text(f.getEntryPoint().getAddressSpace().getName()), 'size': int(f.getBody().getNumAddresses()), 'external': bool(f.isExternal()), 'thunk': bool(f.isThunk())})
                more = bool(iterator.hasNext())
                return {**common, 'items': items, 'offset': offset, 'nextOffset': offset + len(items) if more else None, 'complete': not more, 'total': int(manager.getFunctionCount())}
            address = program.getAddressFactory().getDefaultAddressSpace().getAddress(request['address'])
            if operation == 'xrefs':
                iterator = program.getReferenceManager().getReferencesTo(address)
                offset, limit, index, items = request.get('offset', 0), request['limit'], 0, []
                while iterator.hasNext() and index < offset:
                    monitor.checkCancelled()
                    iterator.next(); index += 1
                while iterator.hasNext() and len(items) < limit:
                    monitor.checkCancelled()
                    ref = iterator.next()
                    items.append({'from': ghidra_address(ref.getFromAddress()), 'to': ghidra_address(ref.getToAddress()), 'type': str(ref.getReferenceType())})
                more = bool(iterator.hasNext())
                return {**common, 'items': items, 'offset': offset, 'nextOffset': offset + len(items) if more else None, 'complete': not more}
            if operation != 'decompile': raise ValueError('Unsupported Ghidra query')
            function = manager.getFunctionContaining(address)
            if function is None: raise ValueError('No analyzed function contains the requested address')
            decompiler = DecompInterface()
            try:
                if not decompiler.openProgram(program): raise RuntimeError(str(decompiler.getLastMessage()))
                result = decompiler.decompileFunction(function, request.get('decompileSeconds', 30), pg.task_monitor(request.get('decompileSeconds', 30)))
                if not result.decompileCompleted(): raise RuntimeError('Ghidra decompile failed: ' + str(result.getErrorMessage()))
                output = result.getDecompiledFunction()
                if output is None: raise RuntimeError('Ghidra returned no decompiled function')
                code, maximum = str(output.getC()), request.get('maxChars', 30000)
                return {**common, 'function': {'name': text(function.getName()), 'address': ghidra_address(function.getEntryPoint())}, 'signature': str(output.getSignature())[:2000], 'code': code[:maximum], 'truncated': len(code) > maximum, 'totalChars': len(code), 'warning': 'Decompiler output is an approximation, not original source or proof of behavioral equivalence'}
            finally:
                decompiler.dispose()
`;
