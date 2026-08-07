const VALUE_OPTIONS = new Set([
  'config',
  'control-url',
  'token-file',
  'gateway-script',
  'capabilities',
  'concurrency',
  'lease-seconds',
  'poll-ms'
]);

const FLAG_OPTIONS = new Set(['allow-http', 'no-spawn', 'once']);

export function parseRunnerArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new Error(`Unexpected Runner argument: ${item}`);
    const key = item.slice(2);
    if (!VALUE_OPTIONS.has(key) && !FLAG_OPTIONS.has(key)) throw new Error(`Unknown Runner option: --${key}`);
    if (Object.hasOwn(output, key)) throw new Error(`Runner option --${key} was provided more than once`);
    if (FLAG_OPTIONS.has(key)) {
      output[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`Runner option --${key} requires a value`);
    output[key] = next;
    index += 1;
  }
  return output;
}

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

export function integerValue(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function booleanFlag(value, label) {
  if (value === undefined) return false;
  if (value !== true) throw new Error(`${label} is a flag and does not accept a value`);
  return true;
}

export function stringValue(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

export function jobTimeout(value) {
  return integerValue(value, 900000, 1000, 3600000, 'Remote job timeoutMs');
}

export const __test = { FLAG_OPTIONS, VALUE_OPTIONS };
