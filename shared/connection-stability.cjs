'use strict';

const { CONNECTION_PROVIDERS } = require('./instance-config.cjs');

function cleanHttpsOrigin(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function publicConnectionStability({ provider = 'ngrok', publicUrl = '' } = {}) {
  if (!CONNECTION_PROVIDERS.includes(provider)) {
    throw new Error(`Unknown connection provider: ${String(provider)}`);
  }
  if (provider === 'cloudflare-quick') {
    return {
      kind: 'temporary',
      publicUrl: '',
      chatgptEligible: false,
      message: 'This Quick Tunnel URL is a temporary session share. It is verified for the current session, but is not a persistent ChatGPT app address.'
    };
  }
  const origin = cleanHttpsOrigin(publicUrl);
  if (!origin) {
    return {
      kind: 'unconfigured',
      publicUrl: '',
      chatgptEligible: false,
      message: 'A stable account-owned HTTPS origin is required before this connection can be used as a persistent ChatGPT app address.'
    };
  }
  return {
    kind: 'stable',
    publicUrl: origin,
    chatgptEligible: true,
    message: 'This account-owned HTTPS origin can be used as a persistent ChatGPT app address.'
  };
}

module.exports = {
  cleanHttpsOrigin,
  publicConnectionStability
};
