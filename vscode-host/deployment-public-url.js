'use strict';

const { normalizeNgrokUrl } = require('../ngrok-support.js');
const { normalizePublicUrl } = require('../tunnel-provider.js');

function stablePublicUrl(settings = {}) {
  const provider = String(settings.provider || '').trim().toLowerCase();
  if (provider === 'ngrok') {
    const value = String(settings.ngrokUrl || '').trim();
    return value ? normalizeNgrokUrl(value) : '';
  }
  if (provider === 'cloudflare-managed' || provider === 'external') {
    const value = String(settings.publicUrl || '').trim();
    return value ? normalizePublicUrl(value) : '';
  }
  if (provider === 'cloudflare-quick') return '';
  throw new Error(`Unsupported tunnel provider: ${provider || 'empty'}`);
}

function publicHost(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  try { return new URL(normalized).host.toLowerCase(); }
  catch { return ''; }
}

function allowedHosts(configured = [], stableUrl = '') {
  if (!Array.isArray(configured)) throw new TypeError('allowedPublicHosts must be an array');
  return [...new Set(
    [...configured, publicHost(stableUrl)]
      .map(value => String(value || '').trim().toLowerCase())
      .filter(Boolean)
  )];
}

module.exports = {
  allowedHosts,
  publicHost,
  stablePublicUrl
};
