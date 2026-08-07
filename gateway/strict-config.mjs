export function defaultedEnum(value, allowed, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`Unknown ${label}: ${String(value)}`);
  }
  return value;
}

export function defaultedInteger(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function defaultedBoolean(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

export function defaultedArray(value, fallback, label) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}
