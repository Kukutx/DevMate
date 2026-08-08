'use strict';

function tunnelStopResult(result) {
  if (result && typeof result === 'object' && result.tunnel && typeof result.tunnel === 'object') return result.tunnel;
  return result && typeof result === 'object' ? result : null;
}

function classifyTunnelStop(result) {
  const tunnel = tunnelStopResult(result);
  if (!tunnel) return { safe: false, remoteOwner: false, reason: 'missing-stop-result', tunnel: null };
  if (tunnel.stopped === true) return { safe: true, remoteOwner: false, reason: 'stopped', tunnel };
  const reason = String(tunnel.reason || '').trim();
  if (reason === 'not-running') return { safe: true, remoteOwner: false, reason, tunnel };
  if (reason === 'managed-by-another-host') return { safe: true, remoteOwner: true, reason, tunnel };
  return { safe: false, remoteOwner: false, reason: reason || 'stop-not-confirmed', tunnel };
}

function assertTunnelSafeForCredentialChange(result, operation = 'provider credential change') {
  const state = classifyTunnelStop(result);
  if (state.safe) return state;
  const error = new Error(`Cannot continue ${operation}: public ingress stop was not confirmed (${state.reason})`);
  error.code = 'DEVMATE_TUNNEL_STOP_REQUIRED';
  error.stop = state.tunnel;
  throw error;
}

module.exports = {
  assertTunnelSafeForCredentialChange,
  classifyTunnelStop,
  tunnelStopResult
};
