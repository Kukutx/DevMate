'use strict';

const SPAWN_LAYER_STATE = Symbol.for('devmate.vscodeSpawnLayers');

function layerState(childProcess) {
  childProcess[SPAWN_LAYER_STATE] ||= [];
  return childProcess[SPAWN_LAYER_STATE];
}

function spawnLayerError(message, code, layerName) {
  const error = new Error(message);
  error.code = code;
  error.layerName = layerName;
  return error;
}

class SpawnLayer {
  constructor({ childProcess, name, wrap }) {
    if (!childProcess || typeof childProcess.spawn !== 'function') {
      throw new TypeError('childProcess.spawn is required');
    }
    if (typeof wrap !== 'function') throw new TypeError('Spawn layer wrap callback is required');
    this.childProcess = childProcess;
    this.name = String(name || 'spawn-layer');
    this.wrap = wrap;
    this.previousSpawn = null;
    this.wrappedSpawn = null;
    this.active = false;
  }

  install() {
    if (this.active) return this;
    const stack = layerState(this.childProcess);
    const previousSpawn = this.childProcess.spawn;
    const wrappedSpawn = this.wrap(previousSpawn);
    if (typeof wrappedSpawn !== 'function') {
      throw spawnLayerError(
        `DevMate spawn layer ${this.name} did not return a function`,
        'DEVMATE_SPAWN_LAYER_INVALID',
        this.name
      );
    }
    this.previousSpawn = previousSpawn;
    this.wrappedSpawn = wrappedSpawn;
    this.childProcess.spawn = wrappedSpawn;
    this.active = true;
    stack.push(this);
    return this;
  }

  dispose() {
    if (!this.active) return { disposed: true, alreadyDisposed: true };
    const stack = layerState(this.childProcess);
    const top = stack.at(-1);
    if (top !== this || this.childProcess.spawn !== this.wrappedSpawn) {
      throw spawnLayerError(
        `DevMate spawn layer ${this.name} must be disposed in reverse installation order`,
        'DEVMATE_SPAWN_LAYER_ORDER_VIOLATION',
        this.name
      );
    }
    stack.pop();
    this.childProcess.spawn = this.previousSpawn;
    this.active = false;
    this.previousSpawn = null;
    this.wrappedSpawn = null;
    if (!stack.length) delete this.childProcess[SPAWN_LAYER_STATE];
    return { disposed: true };
  }

  snapshot() {
    const stack = layerState(this.childProcess);
    return {
      name: this.name,
      active: this.active,
      depth: stack.indexOf(this) + 1,
      stack: stack.map(layer => layer.name)
    };
  }
}

function installedSpawnLayers(childProcess) {
  return [...(childProcess?.[SPAWN_LAYER_STATE] || [])].map(layer => layer.name);
}

module.exports = {
  SPAWN_LAYER_STATE,
  SpawnLayer,
  installedSpawnLayers,
  layerState,
  spawnLayerError
};
