function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

export function installHttpServerBootstrap(httpModule, {
  installers = [],
  onServer = () => {}
} = {}) {
  if (!httpModule || typeof httpModule !== 'object') {
    throw new TypeError('HTTP module is required');
  }
  const originalCreateServer = requiredFunction(httpModule.createServer, 'http.createServer');
  requiredFunction(onServer, 'onServer');
  if (!Array.isArray(installers)) throw new TypeError('installers must be an array');

  let restored = false;
  let trackedCreateServer = null;
  try {
    for (const installer of installers) {
      requiredFunction(installer, 'HTTP bootstrap installer')(httpModule);
    }
    const layeredCreateServer = requiredFunction(httpModule.createServer, 'layered http.createServer').bind(httpModule);
    trackedCreateServer = (...args) => {
      const server = layeredCreateServer(...args);
      onServer(server);
      return server;
    };
    httpModule.createServer = trackedCreateServer;
  } catch (error) {
    httpModule.createServer = originalCreateServer;
    throw error;
  }

  return Object.freeze({
    restore() {
      if (restored) return false;
      restored = true;
      httpModule.createServer = originalCreateServer;
      return true;
    },
    get active() {
      return !restored && httpModule.createServer === trackedCreateServer;
    }
  });
}
