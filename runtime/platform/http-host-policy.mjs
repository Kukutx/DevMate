import { isIP } from 'node:net';

function normalizedAddress(value) {
  return String(value || '').trim().toLowerCase();
}

export function isLoopbackHostname(value) {
  const hostname = normalizedAddress(value).replace(/^\[|\]$/g, '');
  return hostname === 'localhost' || isLoopbackAddress(hostname);
}

export function remoteAddress(req) {
  return normalizedAddress(req?.socket?.remoteAddress);
}

export function isLoopbackAddress(value) {
  const address = normalizedAddress(value);
  if (!isIP(address)) return false;
  return address === '::1' ||
    address === '127.0.0.1' ||
    address.startsWith('127.') ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('::ffff:127.');
}

export function loopbackSocket(req) {
  return isLoopbackAddress(remoteAddress(req));
}

export function hostCandidates(req) {
  const raw = String(req?.headers?.host || '').trim().toLowerCase();
  // Host is an authority, not a URL. Reject userinfo, paths, escapes and
  // malformed ports before using URL normalization for host matching.
  if (!raw || /[\s\\/@?#%]/.test(raw)) return [];
  if (!/^(?:\[[^\]]+\]|[^:[\]]+)(?::[0-9]+)?$/.test(raw)) return [];
  try {
    const parsed = new URL(`http://${raw}`);
    return [...new Set([raw, parsed.hostname.toLowerCase()])];
  } catch {
    return [];
  }
}

export function loopbackHost(req) {
  return hostCandidates(req).some(value =>
    value === 'localhost' ||
    value === '127.0.0.1' ||
    value === '::1' ||
    value === '[::1]'
  );
}

export function isLocalRequest(req) {
  return loopbackHost(req) && loopbackSocket(req);
}

export function hostAllowed(req, config) {
  const candidates = hostCandidates(req);
  if (!candidates.length) return false;
  const localHost = loopbackHost(req);
  if (localHost) return loopbackSocket(req);

  const allowed = Array.isArray(config?.requestPolicy?.allowedHosts)
    ? config.requestPolicy.allowedHosts
    : [];
  if (!allowed.length) return true;
  return allowed.some(item => candidates.includes(String(item || '').trim().toLowerCase()));
}