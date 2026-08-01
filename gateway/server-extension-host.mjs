const HOST_STATE = Symbol.for('devmate.serverExtensionHostState');
const INSTANCE_STATE = Symbol.for('devmate.serverExtensionHostInstanceState');

function compareExtension(a, b) {
  return (a.order - b.order) || a.id.localeCompare(b.id);
}

function instanceStateFor(server) {
  if (!server[INSTANCE_STATE]) {
    Object.defineProperty(server, INSTANCE_STATE, {
      value: {
        initialized: new Set(),
        pending: new Map(),
        registeredTools: new Map()
      }
    });
  }
  return server[INSTANCE_STATE];
}

function publicToolRegistration(name, config = {}) {
  return {
    name,
    title: String(config.title || ''),
    description: String(config.description || ''),
    annotations: { ...(config.annotations || {}) },
    hasInputSchema: Object.hasOwn(config, 'inputSchema'),
    hasOutputSchema: Object.hasOwn(config, 'outputSchema')
  };
}

function stateFor(McpServerClass) {
  const prototype = McpServerClass?.prototype;
  if (!prototype) throw new TypeError('McpServer class with a prototype is required');
  if (prototype[HOST_STATE]) return prototype[HOST_STATE];

  const state = {
    originalRegisterTool: prototype.registerTool,
    originalConnect: prototype.connect,
    decorators: new Map(),
    initializers: new Map()
  };
  if (typeof state.originalRegisterTool !== 'function' || typeof state.originalConnect !== 'function') {
    throw new TypeError('McpServer class must expose registerTool() and connect()');
  }

  Object.defineProperty(prototype, HOST_STATE, { value: state });

  prototype.registerTool = function devmateRegisterTool(name, config, handler) {
    let registration = { name, config: config || {}, handler };
    for (const extension of [...state.decorators.values()].sort(compareExtension)) {
      const next = extension.decorate({ server: this, ...registration });
      if (next && typeof next === 'object') registration = { ...registration, ...next };
    }
    if (typeof registration.handler !== 'function') {
      throw new TypeError(`Tool ${name} does not have a callable handler after DevMate decoration`);
    }
    const instance = instanceStateFor(this);
    if (instance.registeredTools.has(registration.name)) {
      throw new Error(`Duplicate MCP tool registration: ${registration.name}`);
    }
    const result = state.originalRegisterTool.call(
      this,
      registration.name,
      registration.config,
      registration.handler
    );
    instance.registeredTools.set(
      registration.name,
      publicToolRegistration(registration.name, registration.config)
    );
    return result;
  };

  prototype.connect = async function devmateConnect(...args) {
    const instance = instanceStateFor(this);
    for (const extension of [...state.initializers.values()].sort(compareExtension)) {
      if (instance.initialized.has(extension.id)) continue;
      let pending = instance.pending.get(extension.id);
      if (!pending) {
        pending = Promise.resolve().then(() => extension.initialize(this));
        instance.pending.set(extension.id, pending);
      }
      try {
        await pending;
        instance.initialized.add(extension.id);
      } catch (error) {
        instance.pending.delete(extension.id);
        throw error;
      }
      instance.pending.delete(extension.id);
    }
    return state.originalConnect.apply(this, args);
  };

  return state;
}

function normalizeExtension(input, actionName) {
  const id = String(input?.id || '').trim();
  if (!id) throw new Error(`${actionName} id is required`);
  const order = Number.isFinite(Number(input.order)) ? Number(input.order) : 100;
  return { ...input, id, order };
}

export function registerToolDecorator(McpServerClass, input) {
  const state = stateFor(McpServerClass);
  const extension = normalizeExtension(input, 'Tool decorator');
  if (typeof extension.decorate !== 'function') throw new TypeError(`Tool decorator ${extension.id} requires decorate()`);
  if (!state.decorators.has(extension.id)) state.decorators.set(extension.id, extension);
  return extension.id;
}

export function registerServerInitializer(McpServerClass, input) {
  const state = stateFor(McpServerClass);
  const extension = normalizeExtension(input, 'Server initializer');
  if (typeof extension.initialize !== 'function') throw new TypeError(`Server initializer ${extension.id} requires initialize()`);
  if (!state.initializers.has(extension.id)) state.initializers.set(extension.id, extension);
  return extension.id;
}

export function serverExtensionHostStatus(McpServerClass) {
  const state = McpServerClass?.prototype?.[HOST_STATE];
  if (!state) return { installed: false, decorators: [], initializers: [] };
  return {
    installed: true,
    decorators: [...state.decorators.values()].sort(compareExtension).map(item => ({ id: item.id, order: item.order })),
    initializers: [...state.initializers.values()].sort(compareExtension).map(item => ({ id: item.id, order: item.order }))
  };
}

export function serverExtensionInstanceStatus(server) {
  const instance = server?.[INSTANCE_STATE];
  if (!instance) return { initialized: [], pending: [], tools: [] };
  return {
    initialized: [...instance.initialized].sort(),
    pending: [...instance.pending.keys()].sort(),
    tools: [...instance.registeredTools.values()].sort((a, b) => a.name.localeCompare(b.name))
  };
}

export const __test = {
  HOST_STATE,
  INSTANCE_STATE,
  compareExtension,
  instanceStateFor,
  publicToolRegistration,
  stateFor
};
