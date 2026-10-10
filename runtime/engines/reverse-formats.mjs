// Bounded parsers: input is untrusted data, never executable code.
const PE_MACHINES = { 0x14c: 'x86', 0x8664: 'x86_64', 0x1c0: 'ARM', 0x1c4: 'ARMv7', 0xaa64: 'ARM64' };
const ELF_MACHINES = { 3: 'x86', 40: 'ARM', 62: 'x86_64', 183: 'ARM64', 243: 'RISC-V' };
const hx = value => `0x${BigInt(value).toString(16)}`;

function checked(buffer, offset, size) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > buffer.length - size) throw new Error('Malformed binary: structure outside file bounds');
  return offset;
}
function integerOffset(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Malformed binary: offset exceeds safe range');
  return number;
}
function cstring(buffer, offset, max = 512) {
  checked(buffer, offset, 1);
  const end = buffer.indexOf(0, offset);
  const stop = Math.min(end < 0 ? buffer.length : end, offset + max);
  return buffer.toString('utf8', offset, stop);
}
export function entropy(buffer) {
  if (!buffer.length) return 0;
  const counts = new Uint32Array(256);
  for (const byte of buffer) counts[byte]++;
  let result = 0;
  for (const count of counts) if (count) { const p = count / buffer.length; result -= p * Math.log2(p); }
  return Math.round(result * 1000) / 1000;
}

export function parsePE(buffer, limit = 1000) {
  checked(buffer, 0, 64);
  const pe = buffer.readUInt32LE(60);
  checked(buffer, pe, 24);
  if (buffer.toString('hex', pe, pe + 4) !== '50450000') throw new Error('Malformed PE signature');
  const machine = buffer.readUInt16LE(pe + 4), count = buffer.readUInt16LE(pe + 6);
  const optionalSize = buffer.readUInt16LE(pe + 20), optional = pe + 24;
  checked(buffer, optional, optionalSize);
  if (optionalSize < 2) throw new Error('Malformed PE optional header');
  const magic = buffer.readUInt16LE(optional);
  if (![0x10b, 0x20b].includes(magic)) throw new Error('Unsupported PE optional header');
  const bits = magic === 0x20b ? 64 : 32, directoryStart = bits === 64 ? 112 : 96;
  if (optionalSize < directoryStart) throw new Error('Truncated PE optional header');
  if (count > 4096) throw new Error('PE section count exceeds parser limit');
  const sectionsStart = optional + optionalSize;
  checked(buffer, sectionsStart, count * 40);
  const sections = [];
  for (let index = 0; index < count; index++) {
    const at = sectionsStart + index * 40, rawOffset = buffer.readUInt32LE(at + 20), rawSize = buffer.readUInt32LE(at + 16);
    if (rawSize) checked(buffer, rawOffset, rawSize);
    sections.push({
      name: buffer.toString('ascii', at, at + 8).replace(/\0.*$/, ''),
      rva: buffer.readUInt32LE(at + 12), virtualSize: buffer.readUInt32LE(at + 8),
      rawOffset, rawSize, flags: hx(buffer.readUInt32LE(at + 36))
    });
  }
  const headerSize = buffer.readUInt32LE(optional + 60);
  if (headerSize < sectionsStart + count * 40 || headerSize > buffer.length) throw new Error('Malformed PE: header size lies outside file bounds');
  const rvaOffset = (rva, size = 1) => {
    if (rva < Math.min(headerSize, buffer.length) && rva + size <= headerSize) return checked(buffer, rva, size);
    const section = sections.find(item => rva >= item.rva && rva - item.rva <= item.rawSize - size);
    if (!section) throw new Error(`PE RVA ${hx(rva)} is not file-backed`);
    return checked(buffer, section.rawOffset + rva - section.rva, size);
  };
  const directories = Math.min(buffer.readUInt32LE(optional + directoryStart - 4), Math.floor((optionalSize - directoryStart) / 8), 16);
  const directory = index => index < directories ? [buffer.readUInt32LE(optional + directoryStart + index * 8), buffer.readUInt32LE(optional + directoryStart + index * 8 + 4)] : [0, 0];
  const imports = [], exports = [], warnings = [];
  let importsTruncated = false, exportsTruncated = false;
  const [importRva, importSize] = directory(1);
  if (importRva && importSize) {
    try {
      const descriptors = Math.min(Math.floor(importSize / 20), 4096);
      outer: for (let i = 0; i < descriptors; i++) {
        const at = rvaOffset(importRva + i * 20, 20);
        const thunk = buffer.readUInt32LE(at) || buffer.readUInt32LE(at + 16), nameRva = buffer.readUInt32LE(at + 12);
        if (!thunk && !nameRva) break;
        const library = cstring(buffer, rvaOffset(nameRva));
        const width = bits / 8, ordinalFlag = 1n << BigInt(bits - 1);
        for (let j = 0; j <= limit; j++) {
          const entry = rvaOffset(thunk + j * width, width);
          const address = bits === 64 ? buffer.readBigUInt64LE(entry) : BigInt(buffer.readUInt32LE(entry));
          if (!address) break;
          if (imports.length === limit) { importsTruncated = true; break outer; }
          const byOrdinal = !!(address & ordinalFlag);
          imports.push({ library, ...(byOrdinal ? { ordinal: Number(address & 0xffffn) } : { name: cstring(buffer, rvaOffset(integerOffset(address) + 2)) }), iatRva: hx(buffer.readUInt32LE(at + 16) + j * width) });
        }
        if (i === descriptors - 1) importsTruncated = true;
      }
    } catch (error) { warnings.push(`Imports: ${error.message}`); importsTruncated = true; }
  }
  const [exportRva, exportSize] = directory(0);
  if (exportRva && exportSize) {
    try {
      const at = rvaOffset(exportRva, 40), base = buffer.readUInt32LE(at + 16);
      const functions = buffer.readUInt32LE(at + 20), names = buffer.readUInt32LE(at + 24);
      const functionsRva = buffer.readUInt32LE(at + 28), namesRva = buffer.readUInt32LE(at + 32), ordinalsRva = buffer.readUInt32LE(at + 36);
      const byOrdinal = new Map();
      for (let i = 0; i < Math.min(names, limit); i++) {
        const ordinal = buffer.readUInt16LE(rvaOffset(ordinalsRva + i * 2, 2));
        if (ordinal >= functions) throw new Error('Invalid export ordinal');
        byOrdinal.set(ordinal, cstring(buffer, rvaOffset(buffer.readUInt32LE(rvaOffset(namesRva + i * 4, 4)))));
      }
      for (let i = 0; i < Math.min(functions, limit); i++) {
        const rva = buffer.readUInt32LE(rvaOffset(functionsRva + i * 4, 4));
        if (rva) exports.push({ ordinal: base + i, name: byOrdinal.get(i) || null, rva: hx(rva), ...(rva >= exportRva && rva < exportRva + exportSize ? { forwarder: cstring(buffer, rvaOffset(rva)) } : {}) });
      }
      exportsTruncated = functions > limit || names > limit;
    } catch (error) { warnings.push(`Exports: ${error.message}`); exportsTruncated = true; }
  }
  const imageBase = bits === 64 ? buffer.readBigUInt64LE(optional + 24) : BigInt(buffer.readUInt32LE(optional + 28));
  const dllFlags = buffer.readUInt16LE(optional + 70);
  return {
    format: 'PE', bits, endian: 'little', machine: PE_MACHINES[machine] || hx(machine), imageBase: hx(imageBase),
    entryRva: hx(buffer.readUInt32LE(optional + 16)), entryAddress: hx(imageBase + BigInt(buffer.readUInt32LE(optional + 16))),
    imageSize: buffer.readUInt32LE(optional + 56), headerSize, subsystem: buffer.readUInt16LE(optional + 68),
    mitigations: { dynamicBase: !!(dllFlags & 0x40), nxCompatible: !!(dllFlags & 0x100), highEntropyVA: !!(dllFlags & 0x20), controlFlowGuard: !!(dllFlags & 0x4000) },
    sections, imports, importsTruncated, exports, exportsTruncated, warnings
  };
}

export function parseELF(buffer, limit = 1000) {
  checked(buffer, 0, 16);
  const bits = buffer[4] === 1 ? 32 : buffer[4] === 2 ? 64 : 0;
  const endian = buffer[5] === 1 ? 'LE' : buffer[5] === 2 ? 'BE' : '';
  if (!bits || !endian || buffer[6] !== 1) throw new Error('Invalid ELF identification');
  checked(buffer, 0, bits === 64 ? 64 : 52);
  const u16 = at => buffer[`readUInt16${endian}`](checked(buffer, at, 2));
  const u32 = at => buffer[`readUInt32${endian}`](checked(buffer, at, 4));
  const word = at => bits === 64 ? buffer[`readBigUInt64${endian}`](checked(buffer, at, 8)) : BigInt(u32(at));
  const table = integerOffset(word(bits === 64 ? 40 : 32));
  const stride = u16(bits === 64 ? 58 : 46), count = u16(bits === 64 ? 60 : 48), namesIndex = u16(bits === 64 ? 62 : 50);
  const sections = [], warnings = [];
  if (table && !count) warnings.push('ELF extended section numbering is not decoded');
  if (count) {
    if (stride < (bits === 64 ? 64 : 40)) throw new Error('Invalid ELF section stride');
    checked(buffer, table, stride * count);
    for (let i = 0; i < Math.min(count, limit); i++) {
      const at = table + i * stride, type = u32(at + 4);
      const rawOffset = integerOffset(word(at + (bits === 64 ? 24 : 16))), rawSize = integerOffset(word(at + (bits === 64 ? 32 : 20)));
      if (type !== 8 && rawSize) checked(buffer, rawOffset, rawSize);
      sections.push({ nameIndex: u32(at), type, address: hx(word(at + (bits === 64 ? 16 : 12))), rawOffset, rawSize, fileBacked: type !== 8, flags: hx(word(at + 8)) });
    }
    if (namesIndex < count && namesIndex !== 0xffff) {
      const at = table + namesIndex * stride;
      const start = integerOffset(word(at + (bits === 64 ? 24 : 16))), size = integerOffset(word(at + (bits === 64 ? 32 : 20)));
      checked(buffer, start, size);
      for (const section of sections) { section.name = section.nameIndex < size ? cstring(buffer.subarray(start, start + size), section.nameIndex) : ''; delete section.nameIndex; }
    }
  }
  return { format: 'ELF', bits, endian: endian === 'LE' ? 'little' : 'big', machine: ELF_MACHINES[u16(18)] || hx(u16(18)), type: u16(16), entryAddress: hx(word(24)), sections, sectionsTruncated: count > limit, warnings };
}

export function inspectFormat(buffer, limit = 1000) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('Invalid parser entry limit');
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) return parsePE(buffer, limit);
  if (buffer.length >= 4 && buffer.toString('hex', 0, 4) === '7f454c46') return parseELF(buffer, limit);
  const magic = buffer.toString('hex', 0, 4);
  if (['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(magic)) return { format: 'Mach-O candidate', warnings: ['Magic-only identification; headers and universal slices are not decoded'] };
  return { format: 'raw', warnings: [] };
}

export function mapPEAddress(info, value, from = 'rva') {
  if (info.format !== 'PE') throw new Error('Address mapping currently supports PE files');
  let rva;
  if (from === 'va') rva = BigInt(value) - BigInt(info.imageBase);
  else if (from === 'offset') {
    const offset = integerOffset(BigInt(value));
    const section = info.sections.find(item => offset >= item.rawOffset && offset < item.rawOffset + item.rawSize);
    if (offset < info.headerSize) rva = BigInt(offset);
    else if (section) rva = BigInt(section.rva + offset - section.rawOffset);
    else return { fileOffset: offset, rva: null, va: null, fileBacked: false };
  } else rva = BigInt(value);
  if (rva < 0n || rva > 0xffffffffn) throw new Error('RVA is outside PE address range');
  const number = Number(rva), section = info.sections.find(item => number >= item.rva && number < item.rva + Math.max(item.virtualSize, item.rawSize));
  const fileOffset = number < info.headerSize ? number : section && number - section.rva < section.rawSize ? section.rawOffset + number - section.rva : null;
  return { rva: hx(rva), va: hx(BigInt(info.imageBase) + rva), fileOffset, fileBacked: fileOffset !== null, section: section?.name || null };
}
