import net from 'node:net';

function parseIpv4(address) {
  const parts = String(address || '').split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return null;
  const values = parts.map(Number);
  if (values.some(value => value < 0 || value > 255)) return null;
  return values;
}

function ipv4Public(address) {
  const parts = parseIpv4(address);
  if (!parts) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function parseIpv6Words(address) {
  let value = String(address || '').trim().toLowerCase();
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  if (net.isIP(value) !== 6) return null;

  let ipv4Tail = null;
  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (tail.includes('.')) {
    const ipv4 = parseIpv4(tail);
    if (!ipv4) return null;
    ipv4Tail = [(ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]];
    value = `${value.slice(0, lastColon)}:${ipv4Tail[0].toString(16)}:${ipv4Tail[1].toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  if (left.some(part => !/^[0-9a-f]{1,4}$/.test(part)) || right.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  const words = [...left.map(part => parseInt(part, 16)), ...Array(zeros).fill(0), ...right.map(part => parseInt(part, 16))];
  return words.length === 8 ? words : null;
}

function prefixMatches(words, prefixWords, prefixBits) {
  let remaining = prefixBits;
  for (let index = 0; index < words.length && remaining > 0; index += 1) {
    const bits = Math.min(16, remaining);
    const mask = bits === 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    if ((words[index] & mask) !== ((prefixWords[index] || 0) & mask)) return false;
    remaining -= bits;
  }
  return remaining === 0;
}

function mappedIpv4(words) {
  if (!words || words.length !== 8) return null;
  const mapped = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff;
  if (!mapped) return null;
  return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff].join('.');
}

function ipv6Public(address) {
  const words = parseIpv6Words(address);
  if (!words) return false;
  const mapped = mappedIpv4(words);
  if (mapped) return ipv4Public(mapped);

  // Conservative SSRF boundary: native IPv6 metadata targets must be ordinary
  // global unicast (2000::/3), not transition, documentation, benchmarking,
  // protocol-assignment, local, multicast, or translation space.
  if (!prefixMatches(words, [0x2000], 3)) return false;
  if (prefixMatches(words, [0x2001, 0x0000], 23)) return false; // IETF protocol assignments / Teredo / ORCHID space
  if (prefixMatches(words, [0x2001, 0x0002], 48)) return false; // benchmarking
  if (prefixMatches(words, [0x2001, 0x0db8], 32)) return false; // documentation
  if (prefixMatches(words, [0x2002], 16)) return false; // 6to4 embeds IPv4 and can target private space
  if (prefixMatches(words, [0x3fff], 20)) return false; // documentation
  return true;
}

export function publicAddress(address) {
  const value = String(address || '').trim();
  const family = net.isIP(value.split('%')[0]);
  return family === 4 ? ipv4Public(value) : family === 6 ? ipv6Public(value) : false;
}

export const __test = {
  ipv4Public,
  ipv6Public,
  mappedIpv4,
  parseIpv4,
  parseIpv6Words,
  prefixMatches
};