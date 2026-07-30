'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const PROVIDERS = new Set(['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external']);

function commandBase(command) {
  return path.basename(String(command || '').replace(/\\/g, '/')).toLowerCase();
}

function isNgrokCommand(command) {
  return ['ngrok', 'ngrok.exe'].includes(commandBase(command));
}

function normalizeProvider(value) {
  const provider = String(value || 'ngrok').trim().toLowerCase();
  return PROVIDERS.has(provider) ? provider : 'ngrok';
}

function normalizePublicUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(candidate);
  if (url.protocol !== 'https:') throw new Error('Public tunnel URL must use https://');
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('Public tunnel URL must be a clean HTTPS origin');
  }
  if (url.pathname && url.pathname !== '/') throw new Error('Public tunnel URL must not include a path');
  return `https://${url.host}`;
}

function parsePort(args) {
  if (!Array.isArray(args) || String(args[0] || '').toLowerCase() !== 'http') return null;
  for (const value of args.slice(1)) {
    const match = String(value).match(/(?:^|:)(\d{2,5})(?:\/?$)/);
    if (match) return Number(match[1]);
  }
  return null;
}

function parseTryCloudflareUrl(text) {
  return String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/ig)?.at(-1) || '';
}

function hasFlag(args, name) {
  return (args || []).some(value => String(value).split('=')[0].toLowerCase() === name.toLowerCase());
}

function decorateNgrokArgs(args, settings) {
  const next = [...(args || [])];
  const policy = String(settings.ngrokTrafficPolicyFile || '').trim();
  if (policy && !hasFlag(next, '--traffic-policy-file')) next.push('--traffic-policy-file', policy);
  return next;
}

function cloudflareLaunch(provider, port, settings, secrets) {
  const command = String(settings.cloudflareCommandPath || 'cloudflared').trim() || 'cloudflared';
  if (provider === 'cloudflare-quick') {
    return {
      command,
      args: ['tunnel', '--url', `http://127.0.0.1:${port}`],
      options: { windowsHide: true },
      publicUrl: '',
      readyPattern: null
    };
  }
  if (provider !== 'cloudflare-managed') {
    throw new Error(`Unsupported Cloudflare provider: ${provider}`);
  }
  const token = String(secrets.cloudflareTunnelToken || '').trim();
  if (!token) throw new Error('Cloudflare managed tunnel token is not configured in VS Code Secret Storage');
  const publicUrl = normalizePublicUrl(settings.publicUrl);
  if (!publicUrl) throw new Error('Cloudflare managed tunnel requires devMate.publicUrl');
  return {
    command,
    args: ['tunnel', 'run'],
    options: { windowsHide: true, env: { ...process.env, TUNNEL_TOKEN: token } },
    publicUrl,
    readyPattern: /registered tunnel connection|connection .* registered/i
  };
}

function virtualChild(label = 'external tunnel') {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = null;
  child.killed = false;
  child.kill = () => {
    if (child.killed) return true;
    child.killed = true;
    queueMicrotask(() => child.emit('exit', 0, 'SIGTERM'));
    return true;
  };
  queueMicrotask(() => child.stdout.write(`${label} ready\n`));
  return child;
}

class ManagedTunnelProcess extends EventEmitter {
  constructor(manager, launchFactory, originalSpawn, settings) {
    super();
    this.manager = manager;
    this.launchFactory = launchFactory;
    this.originalSpawn = originalSpawn;
    this.settings = settings;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.child = null;
    this.killed = false;
    this.restartCount = 0;
  }

  get pid() {
    return this.child?.pid || null;
  }

  start() {
    if (this.killed || this.manager.current !== this) return;
    let launch;
    try {
      launch = this.launchFactory();
    } catch (error) {
      this.stderr.write(`DevMate tunnel configuration error: ${error.message || error}\n`);
      queueMicrotask(() => this.emit('exit', 1, null));
      return;
    }
    this.child = this.originalSpawn(launch.command, launch.args, { ...(launch.options || {}) });
    this.manager.publicUrl = launch.publicUrl && !launch.readyPattern ? launch.publicUrl : '';
    const inspect = chunk => {
      if (this.manager.current !== this) return;
      const text = String(chunk);
      const quickUrl = parseTryCloudflareUrl(text);
      if (quickUrl) this.manager.publicUrl = quickUrl;
      if (launch.publicUrl && launch.readyPattern?.test(text)) this.manager.publicUrl = launch.publicUrl;
    };
    this.child.stdout?.on('data', chunk => {
      inspect(chunk);
      this.stdout.write(chunk);
    });
    this.child.stderr?.on('data', chunk => {
      inspect(chunk);
      this.stderr.write(chunk);
    });
    this.child.on('error', error => {
      this.stderr.write(`Tunnel process error: ${error.message || error}\n`);
    });
    this.child.on('exit', (code, signal) => this.onChildExit(code, signal));
  }

  onChildExit(code, signal) {
    this.child = null;
    if (this.manager.current === this) this.manager.publicUrl = '';
    if (this.killed || this.manager.current !== this) {
      this.emit('exit', code, signal);
      return;
    }
    const maxRestarts = Math.min(50, Math.max(0, Number(this.settings.maxRestarts) || 10));
    if (this.settings.autoRestart === false || this.restartCount >= maxRestarts) {
      this.emit('exit', code, signal);
      return;
    }
    this.restartCount += 1;
    const delay = Math.min(30000, 1000 * (2 ** Math.min(5, this.restartCount - 1)));
    this.stderr.write(
      `DevMate tunnel exited (code=${code}, signal=${signal || 'none'}); restarting in ${delay}ms (${this.restartCount}/${maxRestarts}).\n`
    );
    setTimeout(() => this.start(), delay).unref?.();
  }

  kill(signal = 'SIGTERM') {
    if (this.killed) return true;
    this.killed = true;
    if (this.manager.current === this) this.manager.publicUrl = '';
    try {
      return this.child?.kill(signal) ?? true;
    } catch {
      return false;
    }
  }
}

function requestTarget(input, options = {}) {
  try {
    if (input instanceof URL) return input;
    if (typeof input === 'string') return new URL(input);
    const protocol = input?.protocol || options.protocol || 'http:';
    const hostname = input?.hostname || options.hostname || input?.host || options.host || '127.0.0.1';
    const port = input?.port || options.port || '';
    const pathname = input?.pathname || input?.path || options.path || '/';
    return new URL(`${protocol}//${hostname}${port ? `:${port}` : ''}${pathname}`);
  } catch {
    return null;
  }
}

function virtualHttpRequest({ statusCode = 200, headers = {}, body = '', onResponse }) {
  const request = new EventEmitter();
  request.writable = true;
  request.write = () => true;
  request.setTimeout = (_ms, callback) => {
    if (callback) request.once('timeout', callback);
    return request;
  };
  request.destroy = error => {
    if (error) queueMicrotask(() => request.emit('error', error));
    return request;
  };
  request.end = () => {
    const response = new PassThrough();
    response.statusCode = statusCode;
    response.headers = headers;
    response.rawHeaders = Object.entries(headers).flatMap(([key, value]) => [key, String(value)]);
    queueMicrotask(() => {
      onResponse?.(response);
      response.end(body);
      request.emit('finish');
    });
    return request;
  };
  return request;
}

class TunnelCompatibilityManager {
  constructor({ settings = () => ({}), secrets = () => ({}), apiPort = 4040, log = () => {} } = {}) {
    this.settingsGetter = settings;
    this.secretsGetter = secrets;
    this.apiPort = apiPort;
    this.log = log;
    this.current = null;
    this.publicUrl = '';
    this.localPort = null;
    this.name = 'devmate-tunnel';
  }

  settings() {
    const raw = this.settingsGetter() || {};
    return {
      provider: normalizeProvider(raw.provider || raw.tunnelProvider),
      publicUrl: raw.publicUrl || '',
      cloudflareCommandPath: raw.cloudflareCommandPath || '',
      ngrokTrafficPolicyFile: raw.ngrokTrafficPolicyFile || '',
      autoRestart: raw.autoRestart,
      maxRestarts: raw.maxRestarts
    };
  }

  wrapSpawn(originalSpawn) {
    return (command, args, options) => {
      if (!isNgrokCommand(command) || String(args?.[0] || '').toLowerCase() !== 'http') {
        return originalSpawn(command, args, options);
      }
      const settings = this.settings();
      if (settings.provider === 'ngrok') {
        return originalSpawn(command, decorateNgrokArgs(args, settings), options);
      }
      const port = parsePort(args);
      if (!port) throw new Error('DevMate could not determine the local gateway port for the selected tunnel provider');
      this.localPort = port;
      this.stop();
      this.localPort = port;
      if (settings.provider === 'external') {
        const publicUrl = normalizePublicUrl(settings.publicUrl);
        if (!publicUrl) throw new Error('External tunnel provider requires devMate.publicUrl');
        this.publicUrl = publicUrl;
        this.current = virtualChild('External tunnel');
        return this.current;
      }
      const proxy = new ManagedTunnelProcess(
        this,
        () => cloudflareLaunch(settings.provider, port, settings, this.secretsGetter() || {}),
        originalSpawn,
        settings
      );
      this.current = proxy;
      proxy.start();
      return proxy;
    };
  }

  wrapHttpRequest(originalRequest) {
    return (input, options, callback) => {
      if (this.settings().provider === 'ngrok') return originalRequest(input, options, callback);
      let effectiveOptions = options;
      let effectiveCallback = callback;
      if (typeof options === 'function') {
        effectiveCallback = options;
        effectiveOptions = {};
      }
      const target = requestTarget(input, effectiveOptions || {});
      const method = String(effectiveOptions?.method || input?.method || 'GET').toUpperCase();
      const isCompatibilityRequest = target &&
        ['127.0.0.1', 'localhost', '::1'].includes(target.hostname) &&
        String(target.port || '80') === String(this.apiPort) &&
        target.pathname.startsWith('/api/tunnels');
      if (!isCompatibilityRequest) return originalRequest(input, options, callback);
      if (method === 'GET' && target.pathname === '/api/tunnels') {
        const tunnels = this.publicUrl ? [{
          name: this.name,
          public_url: this.publicUrl,
          proto: 'https',
          config: { addr: `http://127.0.0.1:${this.localPort}` }
        }] : [];
        return virtualHttpRequest({
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tunnels }),
          onResponse: effectiveCallback
        });
      }
      if (method === 'DELETE' && target.pathname.startsWith('/api/tunnels/')) {
        this.stop();
        return virtualHttpRequest({ statusCode: 204, onResponse: effectiveCallback });
      }
      return virtualHttpRequest({
        statusCode: 404,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'not found' }),
        onResponse: effectiveCallback
      });
    };
  }

  wrapSpawnSync(originalSpawnSync) {
    return (command, args, options) => {
      if (!isNgrokCommand(command)) return originalSpawnSync(command, args, options);
      const settings = this.settings();
      if (settings.provider === 'ngrok') return originalSpawnSync(command, args, options);
      const action = String(args?.[0] || '').toLowerCase();
      if (settings.provider === 'external') {
        return { status: 0, stdout: 'external tunnel provider\n', stderr: '', error: null };
      }
      const cloudflared = String(settings.cloudflareCommandPath || 'cloudflared').trim() || 'cloudflared';
      if (action === 'version') return originalSpawnSync(cloudflared, ['--version'], options);
      if (action === 'config') {
        return {
          status: 0,
          stdout: 'cloudflared configuration managed by DevMate\n',
          stderr: '',
          error: null
        };
      }
      return originalSpawnSync(cloudflared, args, options);
    };
  }

  stop() {
    const current = this.current;
    this.current = null;
    this.publicUrl = '';
    this.localPort = null;
    try { current?.kill?.(); } catch {}
  }

  diagnostics() {
    const settings = this.settings();
    return {
      provider: settings.provider,
      publicUrl: this.publicUrl || normalizePublicUrl(settings.publicUrl || '') || null,
      compatibilityApi: settings.provider === 'ngrok'
        ? 'native ngrok API'
        : `virtual http://127.0.0.1:${this.apiPort}/api/tunnels`,
      localPort: this.localPort,
      running: !!this.current && !this.current.killed,
      pid: this.current?.pid || null,
      autoRestart: settings.autoRestart !== false,
      maxRestarts: Number(settings.maxRestarts) || 10,
      ngrokTrafficPolicyFile: settings.ngrokTrafficPolicyFile || null,
      cloudflareCommandPath: settings.cloudflareCommandPath || 'cloudflared'
    };
  }
}

module.exports = {
  ManagedTunnelProcess,
  TunnelCompatibilityManager,
  cloudflareLaunch,
  decorateNgrokArgs,
  isNgrokCommand,
  normalizeProvider,
  normalizePublicUrl,
  parsePort,
  parseTryCloudflareUrl,
  requestTarget,
  virtualChild,
  virtualHttpRequest
};
