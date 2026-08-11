'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const defaultChildProcess = require('node:child_process');
const { terminateChild } = require('../host/runtime/process-controller.js');
const { StartupLease, waitForStartupLease } = require('../host/runtime/startup-lease.js');
const {
  buildNgrokArgs,
  buildNgrokSpawnOptions,
  classifyNgrokError,
  parseNgrokVersion,
  redactNgrokOutput,
  supportsNgrokEndpointsApi
} = require('../ngrok-support.js');
const {
  cloudflareLaunch,
  decorateNgrokArgs,
  normalizeProvider,
  normalizePublicUrl,
  parseTryCloudflareUrl
} = require('../tunnel-provider.js');
const { tunnelMaxRestarts } = require('./tunnel-settings.js');
const {
  discoverNgrokPublicUrl,
  resolveNgrokAgentApiBase
} = require('./ngrok-agent-api.js');
const {
  DEFAULT_RUNTIME_LEASE_MS,
  SharedTunnelRecordStore,
  configurationKey,
  nowIso
} = require('./shared-tunnel-record-store.js');

const STARTUP_LOCK_NAME = 'tunnel.start.lock';
const DEFAULT_START_TIMEOUT_MS = 20000;
const DEFAULT_READY_TIMEOUT_MS = 20000;
const DEFAULT_HEARTBEAT_MS = 30000;
const DEFAULT_STOP_TIMEOUT_MS = 5000;
const DEFAULT_FORCE_STOP_TIMEOUT_MS = 2000;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function childActive(child) {
  return !!child && child.exitCode == null;
}

function strictAutoRestart(value) {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw new Error('tunnelAutoRestart must be a boolean');
  return value;
}

function normalizeSettings(raw = {}) {
  return {
    ...raw,
    provider: normalizeProvider(raw.provider),
    autoRestart: strictAutoRestart(raw.autoRestart),
    maxRestarts: tunnelMaxRestarts(raw.maxRestarts)
  };
}

function redactExactSecrets(value, secrets = []) {
  let text = String(value || '');
  for (const secret of secrets) {
    const token = String(secret || '');
    if (token.length >= 4) text = text.split(token).join('[REDACTED]');
  }
  return text;
}

function safeProviderOutput(provider, value, secrets = []) {
  const exact = redactExactSecrets(value, secrets);
  return provider === 'ngrok' ? redactNgrokOutput(exact, secrets) : exact;
}

function outputTail(value, maxChars = 2048) {
  const lines = String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  return lines.slice(-6).join(' | ').slice(-maxChars);
}

function providerStartupError(provider, rawOutput, child, { timeoutMs = 0, secrets = [] } = {}) {
  const safeOutput = safeProviderOutput(provider, rawOutput, secrets);
  const detail = outputTail(safeOutput);
  const exit = child && child.exitCode != null ? ` exit=${child.exitCode}` : '';
  const signal = child?.signalCode ? ` signal=${child.signalCode}` : '';
  let code = timeoutMs ? 'DEVMATE_TUNNEL_READY_TIMEOUT' : 'DEVMATE_TUNNEL_PROVIDER_EXITED';
  let message = timeoutMs
    ? `Tunnel provider ${provider} did not publish a valid HTTPS URL within ${timeoutMs}ms`
    : `Tunnel provider ${provider} exited before readiness${exit}${signal}`;

  if (provider === 'ngrok') {
    const classified = classifyNgrokError(safeOutput);
    if (classified?.kind === 'authentication') {
      code = 'DEVMATE_NGROK_AUTHENTICATION';
      message = `ngrok authentication failed${classified.code ? ` (${classified.code})` : ''}. Configure DevMate ngrok credentials or fix the machine ngrok configuration/environment.`;
    } else if (classified?.kind === 'endpoint-conflict') {
      code = 'DEVMATE_NGROK_ENDPOINT_CONFLICT';
      message = `ngrok endpoint is already online${classified.code ? ` (${classified.code})` : ''}. Stop the conflicting ngrok session or enable pooling only when intentional.`;
    } else if (classified?.kind === 'domain') {
      code = 'DEVMATE_NGROK_DOMAIN';
      message = `ngrok could not use the configured stable URL/domain${classified.code ? ` (${classified.code})` : ''}. Verify that the URL belongs to the active ngrok account.`;
    }
  }

  if (detail) message += ` Provider output: ${detail}`;
  const error = new Error(message);
  error.code = code;
  error.provider = provider;
  error.providerOutput = detail;
  error.exitCode = child?.exitCode ?? null;
  error.signalCode = child?.signalCode || null;
  return error;
}

function buildNgrokLaunch(port, settings, secrets) {
  const command = String(settings.ngrokCommandPath || 'ngrok').trim() || 'ngrok';
  let args = buildNgrokArgs(['http', String(port)], {
    url: settings.ngrokUrl || '',
    poolingEnabled: settings.ngrokPoolingEnabled === true
  });
  args = decorateNgrokArgs(args, settings);
  const options = buildNgrokSpawnOptions({ windowsHide: true }, {
    authtoken: secrets.ngrokAuthtoken || '',
    useManagedAccount: settings.ngrokUseManagedAccount === true
  });
  return {
    command,
    args,
    options,
    publicUrl: normalizePublicUrl(settings.ngrokUrl || ''),
    agentApiBase: null,
    readyPattern: null,
    provider: 'ngrok'
  };
}

function buildProviderLaunch(port, settings, secrets) {
  if (settings.provider === 'ngrok') return buildNgrokLaunch(port, settings, secrets);
  if (settings.provider === 'external') {
    const publicUrl = normalizePublicUrl(settings.publicUrl);
    if (!publicUrl) throw new Error('External tunnel provider requires devMate.publicUrl');
    return { command: '', args: [], options: {}, publicUrl, readyPattern: null, provider: 'external' };
  }
  return { ...cloudflareLaunch(settings.provider, port, settings, {
    cloudflareTunnelToken: secrets.cloudflareTunnelToken || ''
  }), provider: settings.provider };
}

class TunnelController {
  constructor({
    stateDirectory,
    settings = () => ({}),
    getSecrets = async () => ({}),
    childProcess = defaultChildProcess,
    httpRequest = http.request,
    hostId = 'vscode',
    logger = () => {},
    runtimeLeaseMs = DEFAULT_RUNTIME_LEASE_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    forceStopTimeoutMs = DEFAULT_FORCE_STOP_TIMEOUT_MS
  } = {}) {
    if (!stateDirectory) throw new Error('A shared state directory is required');
    if (!childProcess?.spawn || !childProcess?.spawnSync) throw new TypeError('A child_process-compatible module is required');
    this.stateDirectory = stateDirectory;
    this.settingsGetter = settings;
    this.getSecrets = getSecrets;
    this.childProcess = childProcess;
    this.httpRequest = httpRequest;
    this.hostId = String(hostId || 'vscode');
    this.logger = logger;
    this.runtimeLeaseMs = Math.max(30000, Number(runtimeLeaseMs) || DEFAULT_RUNTIME_LEASE_MS);
    this.heartbeatMs = Math.max(5000, Number(heartbeatMs) || DEFAULT_HEARTBEAT_MS);
    this.startTimeoutMs = Math.max(1000, Number(startTimeoutMs) || DEFAULT_START_TIMEOUT_MS);
    this.readyTimeoutMs = Math.max(1000, Number(readyTimeoutMs) || DEFAULT_READY_TIMEOUT_MS);
    this.stopTimeoutMs = Math.max(100, Number(stopTimeoutMs) || DEFAULT_STOP_TIMEOUT_MS);
    this.forceStopTimeoutMs = Math.max(100, Number(forceStopTimeoutMs) || DEFAULT_FORCE_STOP_TIMEOUT_MS);
    this.store = new SharedTunnelRecordStore({ stateDirectory, leaseMs: this.runtimeLeaseMs, logger });
    this.ownerId = '';
    this.child = null;
    this.childReady = false;
    this.borrowedProvider = false;
    this.port = 0;
    this.restartCount = 0;
    this.heartbeat = null;
    this.ownershipFailureCount = 0;
    this.ownershipCleanup = null;
    this.providerOutput = new WeakMap();
    this.providerSecrets = new WeakMap();
    this.providerClosed = new WeakMap();
    this.stopping = false;
    this.disposed = false;
  }

  settings() {
    return normalizeSettings(this.settingsGetter() || {});
  }

  match(port) {
    const settings = this.settings();
    return {
      port: Number(port),
      provider: settings.provider,
      configurationKey: configurationKey(settings, port),
      settings
    };
  }

  matches(record, match) {
    return !!record &&
      Number(record.port) === Number(match.port) &&
      record.provider === match.provider &&
      record.configurationKey === match.configurationKey;
  }

  conflict(record, match) {
    const error = new Error(
      `A shared DevMate tunnel is already active for port ${record.port} with different tunnel settings.`
    );
    error.code = 'DEVMATE_TUNNEL_CONFIGURATION_CONFLICT';
    error.activeProvider = record.provider;
    error.requestedProvider = match.provider;
    error.activeOwnerId = record.ownerId;
    return error;
  }

  currentRecord(match = null) {
    const record = this.store.read();
    if (record && match && !this.matches(record, match)) throw this.conflict(record, match);
    return record;
  }

  async waitForReady(match, timeoutMs = this.readyTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const record = this.currentRecord(match);
      if (!record) return null;
      if (record.status === 'ready' && record.publicUrl) return record;
      await delay(150);
    }
    const error = new Error(`DevMate tunnel did not become ready within ${timeoutMs}ms`);
    error.code = 'DEVMATE_TUNNEL_READY_TIMEOUT';
    throw error;
  }

  clearLocalOwnership(ownerId = this.ownerId) {
    if (ownerId && this.ownerId !== ownerId) return false;
    this.ownerId = '';
    this.port = 0;
    this.restartCount = 0;
    this.childReady = false;
    this.borrowedProvider = false;
    this.ownershipFailureCount = 0;
    return true;
  }

  async cleanupLostOwnership(reason, ownerId = this.ownerId) {
    if (!ownerId || this.ownerId !== ownerId) return { cleaned: true, superseded: true };
    if (this.ownershipCleanup) return this.ownershipCleanup;
    this.ownershipCleanup = (async () => {
      this.logger(`Tunnel shared ownership was lost (${reason}); closing the local provider fail-closed.`);
      if (!childActive(this.child)) {
        this.child = null;
        this.stopHeartbeat();
        this.clearLocalOwnership(ownerId);
        return { cleaned: true, exited: true };
      }
      const previousStopping = this.stopping;
      this.stopping = true;
      try {
        let result;
        try {
          result = await this.terminateLocalChild();
        } catch (error) {
          result = { exited: false, error: error?.message || String(error) };
        }
        if (!result.exited) {
          this.logger(`Tunnel ownership-loss cleanup could not confirm provider exit: ${result.error || 'process-exit-timeout'}`);
          return { cleaned: false, exited: false };
        }
        this.child = null;
        this.stopHeartbeat();
        this.clearLocalOwnership(ownerId);
        return { cleaned: true, exited: true };
      } finally {
        this.stopping = previousStopping;
      }
    })();
    try {
      return await this.ownershipCleanup;
    } finally {
      this.ownershipCleanup = null;
    }
  }

  async verifyOwnership() {
    const ownerId = this.ownerId;
    if (!ownerId || this.disposed) return { healthy: false, inactive: true };
    try {
      const record = this.store.read();
      if (record && record.ownerId === ownerId) {
        this.ownershipFailureCount = 0;
        this.store.write(ownerId, { childPid: this.child?.pid || null });
        return { healthy: true };
      }
      const definitive = !!record;
      this.ownershipFailureCount = definitive ? 2 : this.ownershipFailureCount + 1;
      if (this.ownershipFailureCount < 2) {
        this.logger('Tunnel shared ownership record is temporarily unavailable; requiring a second failed heartbeat before fail-closed cleanup.');
        return { healthy: false, pending: true };
      }
      const reason = record ? `owner changed to ${record.ownerId}` : 'shared record missing';
      const cleanup = await this.cleanupLostOwnership(reason, ownerId);
      return { healthy: false, cleanup };
    } catch (error) {
      this.ownershipFailureCount += 1;
      this.logger(`Tunnel heartbeat failed: ${error.message || error}`);
      if (this.ownershipFailureCount < 2) return { healthy: false, pending: true, error };
      const cleanup = await this.cleanupLostOwnership('shared state read/write failure', ownerId);
      return { healthy: false, cleanup, error };
    }
  }

  startHeartbeat() {
    if (this.heartbeat || !this.ownerId) return;
    this.heartbeat = setInterval(() => {
      void this.verifyOwnership().catch(error => {
        this.logger(`Tunnel ownership verification failed: ${error.message || error}`);
      });
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  stopHeartbeat() {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  resetOwnership(ownerId = this.ownerId) {
    this.stopHeartbeat();
    if (ownerId) this.store.remove(ownerId);
    this.clearLocalOwnership(ownerId);
  }

  childOutput(child) {
    return this.providerOutput.get(child) || '';
  }

  childSecrets(child) {
    return this.providerSecrets.get(child) || [];
  }

  async waitForProviderOutput(child, timeoutMs = 250) {
    const closed = this.providerClosed.get(child);
    if (!closed) return;
    await Promise.race([closed, delay(timeoutMs)]);
  }

  async reusableLocalNgrokUrl(match, launch) {
    if (launch.provider !== 'ngrok' || !launch.agentApiBase) return '';
    return discoverNgrokPublicUrl(match.port, {
      apiBase: launch.agentApiBase,
      request: this.httpRequest,
      timeoutMs: 750,
      expectedUrl: launch.publicUrl || ''
    });
  }

  adoptExistingNgrok(match, ownerId, publicUrl) {
    const url = normalizePublicUrl(publicUrl);
    this.ownerId = ownerId;
    this.port = match.port;
    this.child = null;
    this.childReady = false;
    this.borrowedProvider = true;
    this.store.write(ownerId, {
      hostId: this.hostId,
      childPid: null,
      port: match.port,
      provider: match.provider,
      configurationKey: match.configurationKey,
      status: 'ready',
      publicUrl: url,
      readyAt: nowIso()
    });
    this.startHeartbeat();
    this.logger('Reusing existing local ngrok endpoint ' + url + ' for Gateway port ' + match.port + '; DevMate will detach rather than terminate that pre-existing ngrok process on Stop.');
    return this.store.read();
  }

  async providerReadyUrl(launch, match, child, timeoutMs) {
    if (launch.provider === 'external') return launch.publicUrl;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let discovered = '';

    while (Date.now() <= deadline) {
      const output = this.childOutput(child);
      if (!childActive(child)) {
        await this.waitForProviderOutput(child);
        throw providerStartupError(match.provider, this.childOutput(child), child, { secrets: this.childSecrets(child) });
      }
      if (launch.provider === 'cloudflare-quick') {
        discovered = parseTryCloudflareUrl(output) || discovered;
      } else if (launch.publicUrl && launch.readyPattern?.test(output)) {
        discovered = launch.publicUrl;
      }
      if (launch.provider === 'ngrok') {
        discovered = await discoverNgrokPublicUrl(match.port, {
          apiBase: launch.agentApiBase,
          request: this.httpRequest,
          timeoutMs: 750
        });
        if (!discovered && !launch.agentApiBase && launch.publicUrl && Date.now() - startedAt >= 1500) {
          discovered = launch.publicUrl;
        }
      }
      if (discovered) return normalizePublicUrl(discovered);
      await delay(200);
    }
    throw providerStartupError(match.provider, this.childOutput(child), child, {
      timeoutMs,
      secrets: this.childSecrets(child)
    });
  }

  attachChild(child, match, { sensitiveValues = [] } = {}) {
    this.child = child;
    this.childReady = false;
    this.providerOutput.set(child, '');
    this.providerSecrets.set(child, sensitiveValues.filter(Boolean));
    let resolveClosed;
    this.providerClosed.set(child, new Promise(resolve => { resolveClosed = resolve; }));
    const capture = chunk => {
      const previous = this.providerOutput.get(child) || '';
      const safeChunk = safeProviderOutput(match.provider, chunk, this.childSecrets(child));
      this.providerOutput.set(child, `${previous}${safeChunk}`.slice(-MAX_PROVIDER_RESPONSE_BYTES));
    };
    const attachStream = stream => {
      if (!stream) return;
      if (typeof stream.read === 'function') {
        let buffered;
        while ((buffered = stream.read()) !== null) capture(buffered);
      }
      stream.on?.('data', capture);
    };
    attachStream(child.stdout);
    attachStream(child.stderr);

    let terminal = false;
    const finish = (code, signal) => {
      resolveClosed?.();
      if (terminal) return;
      terminal = true;
      if (this.child !== child) return;
      const wasReady = this.childReady;
      const detail = outputTail(safeProviderOutput(match.provider, this.childOutput(child), this.childSecrets(child)));
      this.child = null;
      this.childReady = false;
      if (this.stopping || this.disposed) return;
      this.logger(`Tunnel provider ended code=${code ?? 'none'} signal=${signal || 'none'}${detail ? `: ${detail}` : ''}.`);
      if (!wasReady) {
        this.resetOwnership();
        return;
      }
      void this.handleUnexpectedExit(match).catch(error => {
        this.logger(`Tunnel restart failed: ${error.message || error}`);
        this.resetOwnership();
      });
    };
    child.on?.('error', error => {
      capture(`process error: ${error.message || error}\n`);
      const detail = outputTail(safeProviderOutput(match.provider, error.message || error, this.childSecrets(child)));
      this.logger(`Tunnel process error${detail ? `: ${detail}` : ''}`);
    });
    child.once?.('close', finish);
  }

  async spawnProvider(match, { preserveOwner = false } = {}) {
    const settings = match.settings;
    const secrets = settings.provider === 'external' ? {} : await this.getSecrets();
    const launch = buildProviderLaunch(match.port, settings, secrets || {});
    if (!preserveOwner) {
      this.ownerId = `${this.hostId}-tunnel-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
      this.restartCount = 0;
      this.borrowedProvider = false;
      this.ownershipFailureCount = 0;
    }
    const ownerId = this.ownerId;
    this.port = match.port;
    let child = null;

    try {
      if (launch.provider === 'external') {
        this.store.write(ownerId, {
          hostId: this.hostId,
          childPid: null,
          port: match.port,
          provider: match.provider,
          configurationKey: match.configurationKey,
          status: 'ready',
          publicUrl: launch.publicUrl,
          readyAt: nowIso()
        });
        this.startHeartbeat();
        return this.store.read();
      }

      const checkArgs = launch.provider === 'ngrok' ? ['version'] : ['--version'];
      const check = this.childProcess.spawnSync(launch.command, checkArgs, {
        encoding: 'utf8', windowsHide: true, env: launch.options?.env || process.env
      });
      if (check.error || check.status !== 0) {
        throw new Error(`${launch.command} is unavailable: ${String(check.stderr || check.stdout || check.error?.message || 'unknown error').trim()}`);
      }
      const sensitiveValues = [
        secrets?.ngrokAuthtoken,
        secrets?.cloudflareTunnelToken,
        launch.options?.env?.NGROK_AUTHTOKEN,
        launch.options?.env?.TUNNEL_TOKEN
      ].map(value => String(value || '')).filter(Boolean);
      if (launch.provider === 'ngrok') {
        const version = parseNgrokVersion(`${check.stdout || ''}\n${check.stderr || ''}`);
        if (!version) {
          const error = new Error(`Could not determine the installed ngrok version from: ${outputTail(safeProviderOutput('ngrok', `${check.stdout || ''}\n${check.stderr || ''}`, sensitiveValues)) || 'empty output'}`);
          error.code = 'DEVMATE_NGROK_VERSION_UNKNOWN';
          throw error;
        }
        if (!supportsNgrokEndpointsApi(version)) {
          const error = new Error(`DevMate requires ngrok 3.30.0+ for current Agent API endpoint discovery; found ${version.version}. Upgrade ngrok.`);
          error.code = 'DEVMATE_NGROK_VERSION_UNSUPPORTED';
          error.ngrokVersion = version.version;
          throw error;
        }

        launch.agentApiBase = resolveNgrokAgentApiBase(launch.command, {
          spawnSync: this.childProcess.spawnSync,
          env: launch.options?.env || process.env
        });
        if (!launch.agentApiBase && !launch.publicUrl) {
          const error = new Error('ngrok local Agent API is disabled; configure a stable ngrok URL or enable agent web_addr');
          error.code = 'DEVMATE_NGROK_AGENT_API_DISABLED';
          throw error;
        }
        const reusableUrl = await this.reusableLocalNgrokUrl(match, launch);
        if (reusableUrl) return this.adoptExistingNgrok(match, ownerId, reusableUrl);
      }

      child = this.childProcess.spawn(launch.command, launch.args, launch.options);
      if (!child || typeof child.on !== 'function') throw new Error('Tunnel provider did not return a process-like handle');
      this.attachChild(child, match, { sensitiveValues });
      this.store.write(ownerId, {
        hostId: this.hostId,
        childPid: child.pid || null,
        port: match.port,
        provider: match.provider,
        configurationKey: match.configurationKey,
        status: 'pending',
        publicUrl: ''
      });
      this.startHeartbeat();
      const publicUrl = await this.providerReadyUrl(launch, match, child, this.readyTimeoutMs);
      this.store.write(ownerId, {
        childPid: child.pid || null,
        status: 'ready',
        publicUrl,
        readyAt: nowIso()
      });
      if (this.child === child && this.ownerId === ownerId) this.childReady = true;
      return this.store.read();
    } catch (error) {
      let cleanup = { exited: true, forced: false };
      if (child && childActive(child)) {
        try {
          cleanup = await terminateChild(child, {
            timeoutMs: Math.min(2000, this.stopTimeoutMs),
            forceTimeoutMs: Math.min(1000, this.forceStopTimeoutMs),
            signalCodeConfirmsExit: false
          });
        } catch (cleanupError) {
          cleanup = { exited: false, forced: false, error: cleanupError?.message || String(cleanupError) };
        }
      }
      if (child && childActive(child) && !cleanup.exited) {
        error.cleanupPending = true;
        error.cleanupReason = cleanup.error || 'process-exit-timeout';
        this.logger(`Tunnel startup cleanup did not confirm provider exit: ${error.cleanupReason}`);
        throw error;
      }
      if (launch.provider === 'ngrok' && error?.code === 'DEVMATE_NGROK_ENDPOINT_CONFLICT') {
        const reusableUrl = await this.reusableLocalNgrokUrl(match, launch).catch(() => '');
        if (reusableUrl) {
          if (this.child === child) this.child = null;
          return this.adoptExistingNgrok(match, ownerId, reusableUrl);
        }
      }
      if (this.child === child) this.child = null;
      this.resetOwnership(ownerId);
      throw error;
    }
  }

  async handleUnexpectedExit(match) {
    const settings = this.settings();
    if (!settings.autoRestart || this.restartCount >= settings.maxRestarts || !this.ownerId) {
      this.resetOwnership();
      return;
    }
    this.restartCount += 1;
    const delayMs = Math.min(30000, 1000 * (2 ** Math.min(5, this.restartCount - 1)));
    this.store.write(this.ownerId, { childPid: null, status: 'pending', publicUrl: '', readyAt: null });
    await delay(delayMs);
    if (this.stopping || this.disposed || !this.ownerId) return;

    const nextMatch = this.match(match.port);
    if (!nextMatch.settings.autoRestart || this.restartCount > nextMatch.settings.maxRestarts) {
      this.resetOwnership();
      return;
    }
    if (nextMatch.provider !== match.provider || nextMatch.configurationKey !== match.configurationKey) {
      this.resetOwnership();
      await this.start(match.port);
      return;
    }
    await this.spawnProvider(nextMatch, { preserveOwner: true });
  }

  resultForRecord(record) {
    const local = !!record && record.ownerId === this.ownerId;
    const borrowed = local && this.borrowedProvider;
    return {
      attached: !!record && (!local || borrowed),
      owned: !!record && local && !borrowed,
      publicUrl: record?.publicUrl || '',
      record
    };
  }

  async start(port) {
    if (this.disposed) throw new Error('Tunnel controller is disposed');
    const match = this.match(port);
    const current = this.currentRecord(match);
    if (current) {
      const ready = current.status === 'ready' ? current : await this.waitForReady(match);
      if (ready) return this.resultForRecord(ready);
    }

    const lease = new StartupLease({
      stateDirectory: this.stateDirectory,
      hostId: `${this.hostId}-tunnel`,
      lockName: STARTUP_LOCK_NAME,
      leaseMs: Math.min(30000, this.startTimeoutMs)
    });
    try {
      const acquired = await waitForStartupLease(lease, {
        timeoutMs: this.startTimeoutMs,
        onWait: async () => {
          const record = this.currentRecord(match);
          if (!record) return null;
          return record.status === 'ready' ? record : await this.waitForReady(match, Math.min(2000, this.readyTimeoutMs)).catch(() => null);
        }
      });
      if (!(acquired instanceof StartupLease)) {
        return this.resultForRecord(acquired);
      }
      lease.assertOwned();
      const afterLease = this.currentRecord(match);
      if (afterLease) {
        const ready = afterLease.status === 'ready' ? afterLease : await this.waitForReady(match);
        return this.resultForRecord(ready);
      }
      const record = await this.spawnProvider(match);
      return this.resultForRecord(record);
    } finally {
      lease.release();
    }
  }

  status(port = this.port) {
    const match = Number(port) > 0 ? this.match(port) : null;
    const record = this.currentRecord(match);
    const result = this.resultForRecord(record);
    return {
      running: !!record,
      owned: result.owned,
      attached: result.attached,
      publicUrl: record?.publicUrl || '',
      provider: record?.provider || match?.provider || this.settings().provider,
      port: record?.port || Number(port) || 0,
      record
    };
  }

  async terminateLocalChild() {
    if (!childActive(this.child)) return { exited: true, forced: false };
    return terminateChild(this.child, {
      timeoutMs: this.stopTimeoutMs,
      forceTimeoutMs: this.forceStopTimeoutMs,
      signalCodeConfirmsExit: false
    });
  }

  async stop() {
    const record = this.store.read();
    if (!record) {
      this.stopping = true;
      try {
        const result = await this.terminateLocalChild();
        if (!result.exited) return { stopped: false, reason: 'process-exit-timeout' };
        this.child = null;
        this.resetOwnership();
        return { stopped: false, reason: 'not-running' };
      } finally {
        this.stopping = false;
      }
    }
    if (!this.ownerId || record.ownerId !== this.ownerId) {
      if (this.child || this.ownerId) {
        this.stopping = true;
        try {
          const result = await this.terminateLocalChild();
          if (!result.exited) {
            return { stopped: false, reason: 'local-process-exit-timeout', publicUrl: record.publicUrl };
          }
          this.child = null;
          if (this.ownerId) this.resetOwnership(this.ownerId);
        } finally {
          this.stopping = false;
        }
      }
      return { stopped: false, reason: 'managed-by-another-host', publicUrl: record.publicUrl };
    }
    if (this.borrowedProvider) {
      this.stopping = true;
      try {
        const publicUrl = record.publicUrl;
        this.resetOwnership(this.ownerId);
        return { stopped: true, detached: true, reason: 'detached-existing-provider', publicUrl };
      } finally {
        this.stopping = false;
      }
    }
    this.stopping = true;
    try {
      const result = await this.terminateLocalChild();
      if (!result.exited) return { stopped: false, reason: 'process-exit-timeout' };
      this.child = null;
      this.resetOwnership(this.ownerId);
      return { stopped: true, reason: '' };
    } finally {
      this.stopping = false;
    }
  }

  async dispose({ stopOwned = true } = {}) {
    if (this.disposed) return { disposed: true, alreadyDisposed: true };
    if (stopOwned) {
      const stopped = await this.stop();
      if (childActive(this.child)) return { disposed: false, reason: 'process-exit-timeout', stop: stopped };
    } else if (childActive(this.child) || (!this.borrowedProvider && this.ownerId && this.store.read()?.ownerId === this.ownerId)) {
      return { disposed: false, reason: 'owned-process-running' };
    }
    this.stopHeartbeat();
    this.disposed = true;
    return { disposed: true };
  }
}

module.exports = {
  DEFAULT_FORCE_STOP_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_START_TIMEOUT_MS,
  DEFAULT_STOP_TIMEOUT_MS,
  MAX_PROVIDER_RESPONSE_BYTES,
  STARTUP_LOCK_NAME,
  TunnelController,
  buildNgrokLaunch,
  buildProviderLaunch,
  childActive,
  normalizeSettings,
  strictAutoRestart
};
