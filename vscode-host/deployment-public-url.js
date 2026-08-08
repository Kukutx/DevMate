'use strict';

const { normalizeNgrokUrl } = require('../ngrok-support.js');
const { normalizePublicUrl } = require('../tunnel-provider.js');
const { allowedHosts, publicHost } = require('../shared/deployment-hosts.cjs');

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

module.exports = {
  allowedHosts,
  publicHost,
  stablePublicUrl
};