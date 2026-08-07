export function createRequestConcurrencyLimiter() {
  const principals = new Map();
  let global = 0;

  function enter(principalId, maxGlobal, maxPrincipal) {
    const id = String(principalId || '').trim();
    if (!id) throw new Error('Request concurrency principalId is required');
    if (!Number.isInteger(maxGlobal) || maxGlobal < 1) throw new Error('maxGlobal must be a positive integer');
    if (!Number.isInteger(maxPrincipal) || maxPrincipal < 1) throw new Error('maxPrincipal must be a positive integer');

    const currentPrincipal = principals.get(id) || 0;
    if (global >= maxGlobal) return { allowed: false, reason: 'global', current: global, limit: maxGlobal };
    if (currentPrincipal >= maxPrincipal) {
      return { allowed: false, reason: 'principal', current: currentPrincipal, limit: maxPrincipal };
    }

    global += 1;
    principals.set(id, currentPrincipal + 1);
    let released = false;
    return {
      allowed: true,
      release() {
        if (released) return;
        released = true;
        global = Math.max(0, global - 1);
        const next = Math.max(0, (principals.get(id) || 1) - 1);
        if (next) principals.set(id, next);
        else principals.delete(id);
      }
    };
  }

  function reset() {
    principals.clear();
    global = 0;
  }

  return {
    enter,
    reset,
    principals,
    global: () => global
  };
}
