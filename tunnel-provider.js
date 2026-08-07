'use strict';

const { tunnelProvider } = require('./vscode-host/tunnel-settings.js');

function normalizeProvider(value) {
  const provider = value === undefined ? 'ngrok' : String(value).trim().toLowerCase();
  return tunnelProvider(provider);
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

module.exports = {
  cloudflareLaunch,
  decorateNgrokArgs,
  normalizeProvider,
  normalizePublicUrl,
  parseTryCloudflareUrl
};
