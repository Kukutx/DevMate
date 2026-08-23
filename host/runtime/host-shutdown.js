'use strict';

function reasonOf(result) {
  return String(result?.reason || '').trim();
}

function resourceReleased(result) {
  if (!result) return true;
  if (result.stopped === true || result.disposed === true || result.attached === true) return true;
  return [
    'not-running',
    'managed-by-another-host',
    'detached-existing-provider',
    'already-exited'
  ].includes(reasonOf(result));
}

function sharedResourceRemains(result) {
  return result?.attached === true || reasonOf(result) === 'managed-by-another-host';
}

async function attempt(label, operation, logger) {
  if (typeof operation !== 'function') return { stopped: false, reason: 'not-running' };
  try {
    return await operation();
  } catch (error) {
    const message = error?.message || String(error);
    logger?.(`${label} release failed during host shutdown: ${message}`);
    return { stopped: false, reason: message, error };
  }
}

/**
 * Release only resources owned by the departing desktop host.
 *
 * Tunnel and Gateway release are intentionally independent. A remote tunnel may
 * still point at a Gateway owned by the departing host, and keeping that Gateway
 * alive would orphan it when the host process exits. The surviving host already
 * owns the recovery loop and will re-establish the complete verified generation.
 *
 * This helper never writes the shared desired lifecycle state. A host shutdown is
 * not equivalent to the user explicitly stopping the shared DevMate session.
 */
async function releaseOwnedHostRuntime({
  stopTunnel,
  stopGateway,
  stopAuxiliary,
  logger = () => {}
} = {}) {
  const tunnel = await attempt('Public connection', stopTunnel, logger);
  const auxiliary = await attempt('Auxiliary process', stopAuxiliary, logger);
  const gateway = await attempt('Gateway', stopGateway, logger);

  const tunnelReleased = resourceReleased(tunnel);
  const gatewayReleased = resourceReleased(gateway);
  const auxiliaryReleased = resourceReleased(auxiliary);
  const sharedStillActive = sharedResourceRemains(tunnel) || sharedResourceRemains(gateway);

  return {
    ok: tunnelReleased && gatewayReleased && auxiliaryReleased,
    detached: true,
    sharedStillActive,
    tunnel,
    gateway,
    auxiliary
  };
}

module.exports = {
  reasonOf,
  releaseOwnedHostRuntime,
  resourceReleased,
  sharedResourceRemains
};
