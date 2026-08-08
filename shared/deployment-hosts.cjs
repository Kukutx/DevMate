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
  nextPublicUrl = ''
} = {}) {
  const current = normalizeAllowedHosts(currentAllowedHosts);
  if (!current.length) return [];
  const previousHost = publicHost(previousPublicUrl);
  const nextHost = publicHost(nextPublicUrl);
  const retained = current.filter(host => host !== previousHost);
  return nextHost ? allowedHosts(retained, nextPublicUrl) : retained;
}

module.exports = {
  allowedHosts,
  normalizeAllowedHosts,
  publicHost,
  reconcileAllowedHosts
};