import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeValue, encodeValue, extractStrings, hexAddress, hexBytes, searchBytes } from '../runtime/engines/reverse-values.mjs';
import { entropy, inspectFormat, mapPEAddress } from '../runtime/engines/reverse-formats.mjs';
import { diffBinaries, planPatches, sha256 } from '../runtime/engines/reverse-files.mjs';
import { addScan, ReverseSessionStore, scanPage } from '../runtime/engines/reverse-sessions.mjs';

function peFixture() {
  const data = Buffer.alloc(0x800);
  data.write('MZ'); data.writeUInt32LE(0x80, 60); data.write('PE\0\0', 0x80, 'binary');
  data.writeUInt16LE(0x8664, 0x84); data.writeUInt16LE(1, 0x86); data.writeUInt16LE(240, 0x94);
  const optional = 0x98;
  data.writeUInt16LE(0x20b, optional); data.writeUInt32LE(0x1000, optional + 16);
  data.writeBigUInt64LE(0x140000000n, optional + 24); data.writeUInt32LE(0x2000, optional + 56); data.writeUInt32LE(0x200, optional + 60);
  data.writeUInt16LE(3, optional + 68); data.writeUInt16LE(0x4160, optional + 70); data.writeUInt32LE(16, optional + 108);
  const section = optional + 240;
  data.write('.text', section); data.writeUInt32LE(0x600, section + 8); data.writeUInt32LE(0x1000, section + 12);
  data.writeUInt32LE(0x400, section + 16); data.writeUInt32LE(0x200, section + 20); data.writeUInt32LE(0x60000020, section + 36);
  data.writeUInt32LE(0x1100, optional + 120); data.writeUInt32LE(40, optional + 124);
  data.writeUInt32LE(0x1140, 0x300); data.writeUInt32LE(0x1128, 0x30c); data.writeUInt32LE(0x1180, 0x310);
  data.write('KERNEL32.dll\0', 0x328); data.writeBigUInt64LE(0x1160n, 0x340); data.write('Sleep\0', 0x362);
  data.writeUInt32LE(0x11c0, optional + 112); data.writeUInt32LE(0x100, optional + 116);
  data.writeUInt32LE(1, 0x3d0); data.writeUInt32LE(1, 0x3d4); data.writeUInt32LE(1, 0x3d8);
  data.writeUInt32LE(0x1220, 0x3dc); data.writeUInt32LE(0x1230, 0x3e0); data.writeUInt32LE(0x1240, 0x3e4);
  data.writeUInt32LE(0x1000, 0x420); data.writeUInt32LE(0x1250, 0x430); data.writeUInt16LE(0, 0x440); data.write('demo\0', 0x450);
  return data;
}

function elfFixture(endian = 'LE') {
  const data = Buffer.alloc(512);
  data.set([0x7f, 0x45, 0x4c, 0x46, 2, endian === 'LE' ? 1 : 2, 1]);
  const u16 = (value, at) => data[`writeUInt16${endian}`](value, at);
  const u32 = (value, at) => data[`writeUInt32${endian}`](value, at);
  const u64 = (value, at) => data[`writeBigUInt64${endian}`](BigInt(value), at);
  u16(2, 16); u16(62, 18); u32(1, 20); u64(0xffffffff00000123n, 24); u64(64, 40);
  u16(64, 52); u16(64, 58); u16(2, 60); u16(1, 62);
  u32(1, 128); u32(3, 132); u64(256, 152); u64(11, 160); data.write('\0.shstrtab\0', 256);
  return data;
}

for (const [kind, value] of [['int8', -128], ['uint8', 255], ['int16', -32768], ['uint16', 65535], ['int32', -2147483648], ['uint32', 4294967295], ['int64', '-9223372036854775808'], ['uint64', '18446744073709551615'], ['float32', 1.5], ['float64', -1.125]]) {
  test(`numeric codec preserves ${kind} in both byte orders`, () => {
    for (const endian of ['little', 'big']) assert.equal(decodeValue(encodeValue(value, kind, endian), kind, endian), value);
  });
}

test('numeric codec rejects overflow, unsafe integers and invalid bytes', () => {
  for (const [value, type] of [[256, 'uint8'], [-1, 'uint32'], [Infinity, 'float64'], ['NaN', 'float32'], [1e40, 'float32'], [2 ** 60, 'uint64'], ['18446744073709551616', 'uint64'], [1.2, 'int32'], ['', 'float32']]) assert.throws(() => encodeValue(value, type));
  assert.throws(() => hexBytes('aa zz'));
  assert.throws(() => hexBytes('a'));
  assert.throws(() => hexBytes('aa bb', 1));
  assert.throws(() => decodeValue(Buffer.alloc(1), 'uint32'));
  assert.equal(decodeValue(Buffer.from('0000807f', 'hex'), 'float32'), 'Infinity');
});

test('addresses preserve 64-bit precision and reject signs or overflow', () => {
  assert.equal(hexAddress('18446744073709551615'), '0xffffffffffffffff');
  assert.equal(hexAddress('0xABC'), '0xabc');
  for (const value of [-1, 1.2, 2 ** 60, '1e3', '0x10000000000000000', 'no']) assert.throws(() => hexAddress(value));
});

test('AoB search supports nibble masks, overlap, alignment and lossless pagination', async () => {
  const data = Buffer.from('aaaaaaaaab', 'hex');
  const first = await searchBytes(data, 'A? ??', { limit: 2 });
  assert.deepEqual(first, { matches: [0, 1], nextOffset: 2, complete: false });
  assert.deepEqual((await searchBytes(data, 'A? ??', { offset: first.nextOffset })).matches, [2, 3]);
  assert.deepEqual((await searchBytes(data, 'AA AA', { alignment: 2 })).matches, [0, 2]);
  assert.deepEqual((await searchBytes(data, '?B')).matches, [4]);
  await assert.rejects(searchBytes(data, '?? ??'), /concrete/);
  await assert.rejects(searchBytes(data, 'A'), /tokens/);
});

test('string extraction reports offsets, truncated previews and continuation', async () => {
  const data = Buffer.from('zero\0abcdef\0last\0');
  const first = await extractStrings(data, { minLength: 4, maxLength: 4, limit: 1 });
  assert.equal(first.entries[0].text, 'zero'); assert.equal(first.nextOffset, 5);
  const next = await extractStrings(data, { offset: first.nextOffset, minLength: 4, maxLength: 4 });
  assert.deepEqual(next.entries.map(item => [item.offset, item.text, item.length, item.truncated]), [[5, 'abcd', 6, true], [12, 'last', 4, false]]);
  const utf = Buffer.concat([Buffer.from([255]), Buffer.from('hello\0world', 'utf16le')]);
  assert.deepEqual((await extractStrings(utf, { encoding: 'utf16le' })).entries.map(item => [item.offset, item.text]), [[1, 'hello'], [13, 'world']]);
  const be = Buffer.from('hello', 'utf16le').swap16();
  assert.equal((await extractStrings(be, { encoding: 'utf16be' })).entries[0].text, 'hello');
});

test('PE parser reads sections, imports, exports and mitigation flags', () => {
  const info = inspectFormat(peFixture());
  assert.equal(info.format, 'PE'); assert.equal(info.imageBase, '0x140000000');
  assert.equal(info.entryAddress, '0x140001000'); assert.equal(info.machine, 'x86_64');
  assert.deepEqual(info.imports, [{ library: 'KERNEL32.dll', name: 'Sleep', iatRva: '0x1180' }]);
  assert.deepEqual(info.exports, [{ ordinal: 1, name: 'demo', rva: '0x1000' }]);
  assert.deepEqual(info.warnings, []); assert.equal(info.mitigations.nxCompatible, true);
  assert.equal(mapPEAddress(info, '0x1000').fileOffset, 0x200);
  assert.equal(mapPEAddress(info, '0x140001002', 'va').fileOffset, 0x202);
  assert.equal(mapPEAddress(info, '0x202', 'offset').rva, '0x1002');
  assert.equal(mapPEAddress(info, '0x1500').fileBacked, false);
  assert.equal(mapPEAddress(info, '0x700', 'offset').rva, null);
});

test('PE ordinal imports, forwarders and truncated metadata are explicit', () => {
  const data = peFixture();
  data.writeBigUInt64LE(0x800000000000002an, 0x340);
  data.writeUInt32LE(0x1210, 0x420); data.write('KERNEL32.Sleep\0', 0x410);
  const info = inspectFormat(data);
  assert.equal(info.imports[0].ordinal, 42); assert.equal(info.exports[0].forwarder, 'KERNEL32.Sleep');
  data.writeUInt32LE(0xfffffff0, 0x300);
  const broken = inspectFormat(data);
  assert.equal(broken.importsTruncated, true); assert.match(broken.warnings[0], /Imports/);
});

test('PE parser rejects truncated or oversized structures', () => {
  const data = peFixture();
  assert.throws(() => inspectFormat(data.subarray(0, 32)), /bounds/);
  data.writeUInt16LE(65535, 0x86); assert.throws(() => inspectFormat(data), /limit/);
  const raw = peFixture(); raw.writeUInt32LE(0xffffffff, 0x188 + 20); assert.throws(() => inspectFormat(raw), /bounds/);
  const headers = peFixture(); headers.writeUInt32LE(0xffffffff, 0x98 + 60); assert.throws(() => inspectFormat(headers), /header size/);
});

for (const endian of ['LE', 'BE']) test(`ELF64 ${endian} preserves addresses and reads section names`, () => {
  const info = inspectFormat(elfFixture(endian));
  assert.equal(info.format, 'ELF'); assert.equal(info.entryAddress, '0xffffffff00000123');
  assert.equal(info.sections[1].name, '.shstrtab'); assert.equal(info.sections[1].fileBacked, true);
  assert.equal(inspectFormat(elfFixture(endian), 1).sectionsTruncated, true);
});

test('entropy and unknown format handling are deterministic', () => {
  assert.equal(entropy(Buffer.alloc(4096)), 0);
  assert.equal(entropy(Buffer.from(Array.from({ length: 256 }, (_, i) => i))), 8);
  assert.equal(inspectFormat(Buffer.from([1, 2])).format, 'raw');
  assert.match(inspectFormat(Buffer.from('feedfacf', 'hex')).format, /candidate/);
});

test('patch planning checks hashes, expected bytes, overlap and fixed size', () => {
  const bytes = Buffer.from('abcdefgh');
  const valid = { offset: 2, expectedHex: '6364', replacementHex: '4344' };
  assert.equal(planPatches(bytes, sha256(bytes), [valid]).length, 1);
  assert.throws(() => planPatches(bytes, '0'.repeat(64), [valid]), /SHA-256/);
  assert.throws(() => planPatches(bytes, sha256(bytes), [{ ...valid, expectedHex: '0000' }]), /mismatch/);
  assert.throws(() => planPatches(bytes, sha256(bytes), [{ ...valid, replacementHex: '01' }]), /length/);
  assert.throws(() => planPatches(bytes, sha256(bytes), [valid, valid]), /Overlapping/);
  assert.equal(bytes.toString(), 'abcdefgh');
});

test('binary diff paginates ranges and reports only page counts', async () => {
  const left = Buffer.from([1, 2, 3, 4, 5]), right = Buffer.from([9, 2, 9, 4, 5, 6]);
  const first = await diffBinaries(left, right, { limit: 1 });
  assert.equal(first.changedBytesInPage, 1); assert.equal(first.nextOffset, 2);
  const next = await diffBinaries(left, right, { offset: first.nextOffset });
  assert.deepEqual(next.ranges.map(item => [item.offset, item.length]), [[2, 1], [5, 1]]);
  assert.equal(next.complete, true);
});

test('sessions enforce capacity, expiry, workspace identity and busy preservation', async () => {
  let now = 0;
  const store = new ReverseSessionStore({ now: () => now, maxSessions: 1 });
  const ws = { id: 'one', root: '/one' }, session = store.create(ws, { pid: 7 }, 100);
  assert.throws(() => store.create(ws, {}), /capacity/);
  assert.throws(() => store.get({ ...ws, root: '/other' }, session.id), /workspace/);
  let release;
  const pending = store.use(ws, session.id, () => new Promise(resolve => { release = resolve; }));
  now = 1000; store.prune(); assert.equal(store.entries.size, 1);
  await assert.rejects(store.use(ws, session.id, async () => {}), /busy/);
  assert.throws(() => store.close(ws, session.id), /busy/);
  release(true); assert.equal(await pending, true);
  now = 1200; store.prune(); assert.equal(store.entries.size, 0);
  const generation = store.generation; store.clear(); assert.throws(() => store.create(ws, {}, 100, generation), /stopped/);
});

test('scan baselines are bounded and paginated without leaking candidates into metadata', () => {
  const store = new ReverseSessionStore(), ws = { id: 'one', root: '/one' }, session = store.create(ws, {});
  const args = { dataType: 'uint64', address: '0x1000', length: 16 };
  const page = addScan(session, { candidates: [{ address: '0x1000', hex: '0000000000000000', value: '0' }, { address: '0x1008', hex: '0100000000000000', value: '1' }], complete: false, nextAddress: '0x1010' }, args);
  assert.equal(page.revision, 1); assert.equal(page.metadata.initialComplete, false);
  assert.equal(scanPage(session, page.scanId, 0, 1).nextOffset, 1);
  assert.equal('candidates' in page.metadata, false);
  for (let i = 0; i < 3; i++) addScan(session, { candidates: [], complete: true }, args);
  assert.throws(() => addScan(session, { candidates: [] }, args), /Maximum/);
});
