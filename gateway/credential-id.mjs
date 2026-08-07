export const MAX_GENERATED_CREDENTIAL_ID = 96;

function normalized(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeCredentialId(value, fallback = 'credential', maxLength = MAX_GENERATED_CREDENTIAL_ID) {
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 120) {
    throw new RangeError('Credential ID maxLength must be an integer from 1 to 120');
  }
  const fallbackId = normalized(fallback) || 'credential';
  const source = normalized(value) || fallbackId;
  const bounded = source.slice(0, maxLength).replace(/[-_]+$/g, '');
  if (bounded) return bounded;
  return fallbackId.slice(0, maxLength).replace(/[-_]+$/g, '') || 'c'.slice(0, maxLength);
}

export function uniqueCredentialId(usedValues, requested, {
  fallback = 'credential',
  maxLength = MAX_GENERATED_CREDENTIAL_ID
} = {}) {
  const used = usedValues instanceof Set ? usedValues : new Set(usedValues || []);
  const base = normalizeCredentialId(requested, fallback, maxLength);
  if (!used.has(base)) return base;

  for (let index = 2; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const suffix = `-${index}`;
    if (suffix.length >= maxLength) throw new Error('Credential ID namespace exhausted');
    const head = normalizeCredentialId(base, fallback, maxLength - suffix.length);
    const candidate = `${head}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('Credential ID namespace exhausted');
}
