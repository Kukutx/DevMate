'use strict';

function processAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  if (numeric === process.pid) return true;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function isObsidianBridge(hostId, bridge) {
  return !!(
    bridge &&
    typeof bridge === 'object' &&
    (
      hostId === 'obsidian' ||
      bridge.kind === 'obsidian' ||
      bridge.hostKind === 'obsidian' ||
      String(bridge.hostId || hostId).startsWith('obsidian-')
    )
  );
}

function bridgeProcessIsLive(bridge, { pidIsRunning = processAlive } = {}) {
  const pid = Number(bridge?.pid || 0);
  return !Number.isInteger(pid) || pid <= 0 || pidIsRunning(pid);
}

function liveObsidianBridgeEntries(config, options = {}) {
  return Object.entries(config?.hostBridges || {}).filter(([hostId, bridge]) =>
    isObsidianBridge(hostId, bridge) && bridgeProcessIsLive(bridge, options)
  );
}

function pruneDeadObsidianBridges(config, { pidIsRunning = processAlive } = {}) {
  if (!config?.hostBridges || typeof config.hostBridges !== 'object') return 0;
  let removed = 0;
  for (const [hostId, bridge] of Object.entries(config.hostBridges)) {
    if (!isObsidianBridge(hostId, bridge)) continue;
    const pid = Number(bridge?.pid || 0);
    if (!Number.isInteger(pid) || pid <= 0 || pidIsRunning(pid)) continue;
    delete config.hostBridges[hostId];
    removed += 1;
  }
  return removed;
}

module.exports = {
  bridgeProcessIsLive,
  isObsidianBridge,
  liveObsidianBridgeEntries,
  processAlive,
  pruneDeadObsidianBridges
};
