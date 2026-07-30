import { incrementCounter, observeDuration, renderPrometheusMetrics, setGauge } from './observability.mjs';

const INSTALLED = Symbol.for('devmate.httpObservabilityInstalled');
let inflight = 0;

function pathname(req) {
  try { return new URL(req.url || '/', 'http://localhost').pathname; }
  catch { return ''; }
}

function isLocal(req) {
  const address = req.socket?.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function routeLabel(path) {
  if (path === '/mcp') return 'mcp';
  if (path === '/health') return 'health';
  if (path === '/control/health') return 'control_health';
  if (path === '/control/metrics') return 'control_metrics';
  if (path.startsWith('/devmate/previews/')) return 'published_preview';
  return 'other';
}

export function instrumentHttpListener(listener) {
  if (typeof listener !== 'function') throw new TypeError('HTTP listener must be a function');
  return function devmateObservedListener(req, res) {
    const path = pathname(req);
    if (path === '/control/metrics') {
      if (!isLocal(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      const body = renderPrometheusMetrics();
      res.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store'
      });
      res.end(body);
      return;
    }

    const started = Date.now();
    const route = routeLabel(path);
    inflight += 1;
    setGauge('devmate_http_inflight', {}, inflight);
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      inflight = Math.max(0, inflight - 1);
      setGauge('devmate_http_inflight', {}, inflight);
      const status = Number(res.statusCode || 0);
      incrementCounter('devmate_http_requests_total', { route, method: req.method || 'UNKNOWN', status }, 1);
      observeDuration('devmate_http_request_duration_ms', { route, method: req.method || 'UNKNOWN' }, Date.now() - started);
      if (status >= 400) incrementCounter('devmate_http_errors_total', { route, status }, 1);
    };
    res.once('finish', finish);
    res.once('close', finish);
    return listener(req, res);
  };
}

export function installHttpObservability(httpModule) {
  if (httpModule[INSTALLED]) return;
  Object.defineProperty(httpModule, INSTALLED, { value: true });
  const originalCreateServer = httpModule.createServer;
  let pendingGatewayServer = true;
  httpModule.createServer = function devmateObservedCreateServer(...args) {
    if (!pendingGatewayServer) return originalCreateServer.apply(this, args);
    pendingGatewayServer = false;
    if (typeof args[0] === 'function') args[0] = instrumentHttpListener(args[0]);
    else if (typeof args[1] === 'function') args[1] = instrumentHttpListener(args[1]);
    return originalCreateServer.apply(this, args);
  };
}

export const __test = { isLocal, pathname, routeLabel };
