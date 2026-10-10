import { setImmediate as yieldNow } from 'node:timers/promises';

export const VALUE_TYPES = Object.freeze(['int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64', 'float32', 'float64']);
const TYPES = Object.freeze({
  int8: ['Int8', 1], uint8: ['UInt8', 1], int16: ['Int16', 2], uint16: ['UInt16', 2],
  int32: ['Int32', 4], uint32: ['UInt32', 4], int64: ['BigInt64', 8], uint64: ['BigUInt64', 8],
  float32: ['Float', 4], float64: ['Double', 8]
});

export function hexAddress(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Address must be a safe integer or a decimal/hex string');
  const text = String(value);
  if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(text)) throw new Error('Invalid unsigned address');
  const address = BigInt(text);
  if (address > 0xffffffffffffffffn) throw new Error('Address exceeds 64 bits');
  return `0x${address.toString(16)}`;
}

export function hexBytes(value, maxBytes = 65536) {
  const text = String(value).replace(/\s/g, '');
  if (!text.length || text.length % 2 || !/^[0-9a-f]+$/i.test(text)) throw new Error('Expected a non-empty, even-length hexadecimal byte string');
  if (text.length / 2 > maxBytes) throw new Error(`Byte input exceeds ${maxBytes} bytes`);
  return Buffer.from(text, 'hex');
}

export function valueType(type, endian = 'little') {
  if (!Object.hasOwn(TYPES, type)) throw new Error(`Unsupported value type: ${type}`);
  if (!['little', 'big'].includes(endian)) throw new Error('Invalid byte order');
  const [name, size] = TYPES[type];
  return { size, name: name + (size === 1 ? '' : endian === 'little' ? 'LE' : 'BE') };
}

export function encodeValue(value, type, endian = 'little') {
  const { size, name } = valueType(type, endian);
  const result = Buffer.alloc(size);
  let number;
  if (type.endsWith('64') && !type.startsWith('float')) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Use a decimal string for 64-bit integer values');
    if (!/^-?[0-9]+$/.test(String(value))) throw new Error('Expected an integer');
    number = BigInt(value);
  } else {
    if (String(value).trim() === '') throw new Error('Expected a number');
    number = Number(value);
    if (!Number.isFinite(number) || (!type.startsWith('float') && !Number.isSafeInteger(number))) throw new Error('Expected a finite value of the selected type');
  }
  result[`write${name}`](number, 0);
  if (type.startsWith('float') && !Number.isFinite(result[`read${name}`](0))) throw new Error('Floating point overflow');
  return result;
}

export function decodeValue(bytes, type, endian = 'little', offset = 0) {
  const { size, name } = valueType(type, endian);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length) throw new Error('Value lies outside the supplied bytes');
  const value = bytes[`read${name}`](offset);
  return typeof value === 'bigint' || !Number.isFinite(value) ? String(value) : value;
}

export function compilePattern(value) {
  const tokens = String(value).trim().split(/\s+/);
  if (!tokens.length || tokens.length > 256 || tokens.some(token => !/^[a-f0-9?]{2}$/i.test(token))) {
    throw new Error('Use 1..256 space-separated byte tokens, e.g. 48 8B ?? A?');
  }
  const bytes = [], masks = [];
  for (const token of tokens) {
    bytes.push(parseInt(token.replaceAll('?', '0'), 16));
    masks.push((token[0] === '?' ? 0 : 0xf0) | (token[1] === '?' ? 0 : 0x0f));
  }
  if (masks.every(mask => mask === 0)) throw new Error('Pattern must contain at least one concrete nibble');
  return { bytes, masks, anchor: masks.indexOf(255) };
}

export async function searchBytes(buffer, pattern, { offset = 0, limit = 200, alignment = 1 } = {}) {
  const { bytes, masks, anchor } = compilePattern(pattern);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 5000 || !Number.isInteger(alignment) || alignment < 1 || alignment > 4096) throw new Error('Invalid search bounds');
  const matches = [];
  let cursor = offset, lastYield = cursor;
  for (; cursor + bytes.length <= buffer.length; cursor++) {
    if (cursor - lastYield >= 1024 * 1024) { await yieldNow(); lastYield = cursor; }
    if (anchor >= 0) {
      const found = buffer.indexOf(bytes[anchor], cursor + anchor);
      if (found < 0) break;
      cursor = found - anchor;
      if (cursor + bytes.length > buffer.length) break;
    }
    if (cursor % alignment) continue;
    if (!bytes.every((value, index) => (buffer[cursor + index] & masks[index]) === value)) continue;
    if (matches.length === limit) return { matches, nextOffset: cursor, complete: false };
    matches.push(cursor);
  }
  return { matches, nextOffset: null, complete: true };
}

export async function extractStrings(buffer, { encoding = 'ascii', offset = 0, minLength = 4, maxLength = 256, limit = 200 } = {}) {
  if (!['ascii', 'utf16le', 'utf16be'].includes(encoding)) throw new Error('Unsupported string encoding');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(minLength) || minLength < 2 || !Number.isInteger(maxLength) || maxLength < minLength || maxLength > 4096 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid string bounds');
  const width = encoding === 'ascii' ? 1 : 2;
  const entries = [];
  let cursor = offset, lastYield = cursor;
  // UTF-16 searches include odd offsets; only printable ASCII code units are selected.
  while (cursor + width <= buffer.length) {
    if (cursor - lastYield >= 1024 * 1024) { await yieldNow(); lastYield = cursor; }
    const start = cursor;
    let length = 0, text = '';
    while (cursor + width <= buffer.length) {
      const code = width === 1 ? buffer[cursor] : encoding === 'utf16le' ? buffer.readUInt16LE(cursor) : buffer.readUInt16BE(cursor);
      if (code < 32 || code > 126) break;
      if (length < maxLength) text += String.fromCharCode(code);
      length++; cursor += width;
      if (cursor - lastYield >= 1024 * 1024) { await yieldNow(); lastYield = cursor; }
    }
    if (length >= minLength) {
      if (entries.length === limit) return { entries, nextOffset: start, complete: false };
      entries.push({ offset: start, encoding, length, text, truncated: length > maxLength });
    }
    cursor = Math.max(start + 1, cursor + (width === 1 ? 1 : 0));
  }
  return { entries, nextOffset: null, complete: true };
}
