import { isLocalRequest } from './http-host-policy.mjs';

const INSTALLED = Symbol.for('devmate.localControlGuardInstalled');
const LOCAL_CONTROL_PATHS = new Set(['/control/health', '/control/metrics']);

function pathname(req) {
  try { return new URL(req.url || '/', 'http://localhost').pathname; }
  catch { return ''; }
}

export function guardLocalControlListener(listener) {
  if (typeof listener !== 'function') throw new TypeError('HTTP listener must be a function');
  return function devmateLocalControlGuard(req, res) {
    const path = pathname(req);
    if (LOCAL_CONTROL_PATHS.has(path) && !isLocalRequest(req)) {
      res.writeHead(403, {
        'content-type': 'application/json',
        'cache-control': 'no-store'
      });
      res.end(JSON.stringify({ error: 'local control endpoint only' }));
      return;
    }
    return listener(req, res);
  };
}

export function installLocalControlGuard(httpModule) {
  if (httpModule[INSTALLED]) return;
  Object.defineProperty(httpModule, INSTALLED, { value: true });
  const originalCreateServer = httpModule.createServer;
  let pendingGatewayServer = true;
  httpModule.createServer = function devmateLocalControlCreateServer(...args) {
    if (!pendingGatewayServer) return originalCreateServer.apply(this, args);
    pendingGatewayServer = false;
    if (typeof args[0] === 'function') args[0] = guardLocalControlListener(args[0]);
    else if (typeof args[1] === 'function') args[1] = guardLocalControlListener(args[1]);
    return originalCreateServer.apply(this, args);
  };
}

export const __test = { LOCAL_CONTROL_PATHS, pathname };
