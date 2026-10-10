export const SCANNER_SOURCE = String.raw`
FORMATS = {'int8': 'b', 'uint8': 'B', 'int16': 'h', 'uint16': 'H', 'int32': 'i', 'uint32': 'I', 'int64': 'q', 'uint64': 'Q', 'float32': 'f', 'float64': 'd'}

def codec(request):
    kind = request['dataType']
    if kind not in FORMATS or request.get('endian', 'little') not in ('little', 'big'): raise ValueError('Invalid numeric type or byte order')
    return struct.Struct(('<' if request.get('endian', 'little') == 'little' else '>') + FORMATS[kind])

def scalar(value, request):
    if request['dataType'].startswith('float'):
        number = float(value)
        if not math.isfinite(number): raise ValueError('Values must be finite')
    else:
        if isinstance(value, bool) or not re.fullmatch(r'-?[0-9]+', str(value)): raise ValueError('Expected an integer; use strings for int64/uint64')
        number = int(value)
    packed = codec(request).pack(number)
    number = codec(request).unpack(packed)[0]
    if isinstance(number, float) and not math.isfinite(number): raise ValueError('Floating point overflow')
    return number

def prepare_comparison(request, rescan=False):
    mode = request.get('comparison', 'equal')
    allowed = ('equal', 'not_equal', 'between', 'unknown') if not rescan else ('equal', 'not_equal', 'between', 'changed', 'unchanged', 'increased', 'decreased', 'increased_by', 'decreased_by')
    if mode not in allowed: raise ValueError('Invalid scan comparison')
    epsilon = float(request.get('epsilon', 0))
    if not math.isfinite(epsilon) or epsilon < 0: raise ValueError('Invalid float tolerance')
    target = scalar(request['value'], request) if mode in ('equal', 'not_equal', 'between', 'increased_by', 'decreased_by') else None
    upper = scalar(request['upperValue'], request) if mode == 'between' else None
    if upper is not None and upper < target: raise ValueError('Range upper value is below lower value')
    def equal(a, b):
        return abs(a - b) <= epsilon if request['dataType'].startswith('float') else a == b
    def compare(current, previous=None):
        if isinstance(current, float) and not math.isfinite(current): return False
        if mode == 'unknown': return True
        if mode == 'equal': return equal(current, target)
        if mode == 'not_equal': return not equal(current, target)
        if mode == 'between': return target <= current <= upper
        if mode == 'changed': return not equal(current, previous)
        if mode == 'unchanged': return equal(current, previous)
        if mode == 'increased': return current > previous
        if mode == 'decreased': return current < previous
        if mode == 'increased_by': return equal(current - previous, target)
        if mode == 'decreased_by': return equal(previous - current, target)
        return False
    return compare, target

def public_value(value, kind):
    return str(value) if kind in ('int64', 'uint64') else value

def pattern_regex(text):
    tokens = text.strip().split()
    if not 1 <= len(tokens) <= 256 or any(not re.fullmatch('[a-fA-F0-9?]{2}', token) for token in tokens): raise ValueError('Invalid byte pattern')
    if all(token == '??' for token in tokens): raise ValueError('Pattern must contain a concrete nibble')
    parts = []
    for token in tokens:
        mask = (0 if token[0] == '?' else 240) | (0 if token[1] == '?' else 15)
        value = int(token.replace('?', '0'), 16)
        options = bytes(v for v in range(256) if v & mask == value)
        parts.append(re.escape(options) if len(options) == 1 else b'[' + re.escape(options) + b']')
    return re.compile(b''.join(parts), re.DOTALL), len(tokens)

def scan_memory(request, handle, identity, pattern=False):
    address = int(request['address'], 0)
    length = int(request['length'])
    if not 1 <= length <= 64 * 1024 * 1024 or address < 0 or address + length > (1 << (identity['pointerSize'] * 8)): raise ValueError('Scan address range outside bounds')
    maximum = int(request.get('maxCandidates', 5000))
    if not 1 <= maximum <= 5000: raise ValueError('Candidate limit outside bounds')
    if pattern:
        regex, width = pattern_regex(request['pattern'])
        fmt, compare, fast = None, None, None
    else:
        fmt = codec(request); width = fmt.size
        compare, target = prepare_comparison(request)
        fast = fmt.pack(target) if request.get('comparison', 'equal') == 'equal' and not request['dataType'].startswith('float') else None
    alignment = int(request.get('alignment', width if not pattern else 1))
    if not 1 <= alignment <= 4096: raise ValueError('Invalid scan alignment')
    end, cursor = address + length, address
    candidates, read_bytes, skipped, scanned = [], 0, 0, 0
    deadline = time.monotonic() + min(25, request.get('budgetMs', 10000) / 1000)
    def result(next_address, reason=None):
        return {'candidates': candidates, 'nextAddress': hex(next_address) if next_address is not None else None, 'complete': next_address is None and skipped == 0, 'stopReason': reason, 'bytesRead': read_bytes, 'skippedBytes': skipped, 'valuesExamined': scanned}
    while cursor < end:
        if time.monotonic() >= deadline: return result(cursor, 'time_budget')
        try: region = memory_region(handle, cursor)
        except (OSError, ValueError): return result(cursor, 'region_unavailable')
        stop = min(end, region['base'] + region['size'])
        if not region['readable'] or (request.get('writableOnly', False) and not region['writable']):
            skipped += stop - cursor; cursor = stop; continue
        while cursor < stop:
            span = min(256 * 1024, stop - cursor)
            size = min(span + width - 1, end - cursor)
            try: data = read_raw(handle, cursor, size)
            except (OSError, ValueError):
                # Preserve readable bytes when overlap enters a guarded/unreadable
                # next region; otherwise include adjacent readable-region matches.
                if size > span:
                    try: data = read_raw(handle, cursor, span)
                    except (OSError, ValueError):
                        skipped += span; cursor += span; continue
                else:
                    skipped += span; cursor += span; continue
            read_bytes += len(data)
            pos = (-cursor) % alignment
            while pos + width <= len(data) and pos < span:
                if scanned % 4096 == 0 and time.monotonic() >= deadline: return result(cursor + pos, 'time_budget')
                if pattern:
                    found = regex.search(data, pos)
                    if not found or found.start() >= span: break
                    pos = found.start()
                elif fast is not None:
                    pos = data.find(fast, pos)
                    if pos < 0 or pos >= span: break
                if (cursor + pos) % alignment:
                    pos += 1; scanned += 1; continue
                scanned += 1
                value = None if pattern else fmt.unpack_from(data, pos)[0]
                if pattern or compare(value):
                    if len(candidates) == maximum: return result(cursor + pos, 'candidate_limit')
                    entry = {'address': hex(cursor + pos), 'hex': data[pos:pos + width].hex()}
                    if not pattern: entry['value'] = public_value(value, request['dataType'])
                    candidates.append(entry)
                pos += alignment if not pattern and fast is None else 1
            cursor += span
    return result(None, 'unreadable_or_filtered_ranges' if skipped else None)

def rescan_memory(request, handle):
    candidates = request['candidates']
    if len(candidates) > 5000: raise ValueError('Too many rescan candidates')
    fmt = codec(request)
    compare, unused = prepare_comparison(request, True)
    groups = {}
    for item in candidates:
        address = int(item['address'], 0)
        if len(bytes.fromhex(item['hex'])) != fmt.size: raise ValueError('Invalid candidate baseline')
        groups.setdefault(address // 4096, []).append((address, item))
    result, unreadable, read_bytes = [], 0, 0
    deadline = time.monotonic() + min(25, request.get('budgetMs', 10000) / 1000)
    for group in groups.values():
        if time.monotonic() >= deadline: raise ValueError('Rescan time budget exceeded; previous baseline retained')
        start = min(pair[0] for pair in group); end = max(pair[0] for pair in group) + fmt.size
        try:
            data = read_raw(handle, start, end - start); read_bytes += len(data)
        except (OSError, ValueError): data = None
        for address, item in group:
            try:
                current = data[address - start:address - start + fmt.size] if data is not None else read_raw(handle, address, fmt.size)
                value = fmt.unpack(current)[0]
                previous = fmt.unpack(bytes.fromhex(item['hex']))[0]
                if compare(value, previous): result.append({'address': hex(address), 'hex': current.hex(), 'value': public_value(value, request['dataType'])})
            except (OSError, ValueError): unreadable += 1
    return {'candidates': result, 'previousCount': len(candidates), 'unreadableCandidates': unreadable, 'complete': unreadable == 0, 'bytesRead': read_bytes}
`;
