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
  if (!raw) return [];
  const candidates = new Set([raw]);
  try {
    const parsed = new URL(`http://${raw}`);
    candidates.add(parsed.hostname.toLowerCase());
  } catch {}
  return [...candidates];
}

export function loopbackHost(req) {
  return hostCandidates(req).some(value =>
    value === 'localhost' ||
    value.startsWith('localhost:') ||
    value === '127.0.0.1' ||
    value.startsWith('127.0.0.1:') ||
    value === '::1' ||
    value === '[::1]' ||
    value.startsWith('[::1]:')
  );
}

export function isLocalRequest(req) {
  return loopbackHost(req) && loopbackSocket(req);
}

export function hostAllowed(req, config) {
  const candidates = hostCandidates(req);
  const localHost = loopbackHost(req);
  if (localHost) return loopbackSocket(req);

  const allowed = Array.isArray(config?.requestPolicy?.allowedHosts)
    ? config.requestPolicy.allowedHosts
    : [];
  if (!allowed.length) return true;
  return allowed.some(item => candidates.includes(String(item || '').trim().toLowerCase()));
}