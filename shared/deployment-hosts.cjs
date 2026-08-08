'use strict';

function publicHost(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  try { return new URL(normalized).host.toLowerCase(); }
  catch { return ''; }
}

function normalizeAllowedHosts(values = []) {
  if (!Array.isArray(values)) throw new TypeError('allowedHosts must be an array');
  return [...new Set(values
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean))];
}

function allowedHosts(configured = [], stableUrl = '') {
  return normalizeAllowedHosts([...normalizeAllowedHosts(configured), publicHost(stableUrl)]);
}

function reconcileAllowedHosts({
  currentAllowedHosts = [],
  previousPublicUrl = '',
  nextPublicUrl = '',
  nextMode = 'personal'
} = {}) {
  const mode = String(nextMode || '').trim().toLowerCase();
  if (!['personal', 'team', 'production'].includes(mode)) throw new Error(`Unknown deployment mode: ${nextMode}`);
  const current = normalizeAllowedHosts(currentAllowedHosts);
  const previousHost = publicHost(previousPublicUrl);
  const nextHost = publicHost(nextPublicUrl);
  const retained = current.filter(host => host !== previousHost);

  if (mode === 'production') return allowedHosts(retained, nextPublicUrl);
  if (mode === 'team' && current.length > 0 && nextHost) return allowedHosts(retained, nextPublicUrl);
  return retained;
}

module.exports = {
  allowedHosts,
  normalizeAllowedHosts,
  publicHost,
  reconcileAllowedHosts
};
