export function integerOption(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d+$/.test(value.trim())
      ? Number(value.trim())
      : NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return number;
}

export function booleanFlag(value, label) {
  if (value === undefined) return false;
  if (value !== true) throw new Error(`${label} is a flag and does not accept a value`);
  return true;
}

export function jobTimeout(value) {
  if (value === undefined) return 900000;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1000 || value > 3600000) {
    throw new Error('Remote job timeoutMs must be an integer from 1000 to 3600000');
  }
  return value;
}
