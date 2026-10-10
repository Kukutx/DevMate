// Command lines are shown to people other than the one who typed them: in the
// activity of a project, in process and job lists. Credentials written inline
// are replaced before a command is displayed or recorded for display. The
// command that runs is never changed. This is a best effort on well-known
// shapes, not a guarantee: a secret in an unusual form is not recognised.
const MARK = '[redacted]';
const RULES = [
  // Authorization headers and bearer tokens.
  [/\b(authorization\s*[:=]\s*(?:"|')?(?:bearer|basic|token)\s+)[^\s"']+/gi, '$1' + MARK],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1' + MARK],
  // --token value, --password=value, -p value for the common long names.
  [/(--?(?:token|password|passwd|pwd|secret|api[-_]?key|access[-_]?key|auth[-_]?token|client[-_]?secret)(?:\s*=\s*|\s+))("[^"]*"|'[^']*'|[^\s"']+)/gi, '$1' + MARK],
  // NAME=value and $env:NAME = 'value' where one word of the name says it is a credential
  // (GITHUB_TOKEN, DB_PASSWORD, API_KEY), not merely contains such a word (TOKENS_PER_PAGE).
  [/(^|[\s;&|(])((?:\$env:)?(?:[A-Za-z0-9]+_)*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)(?:_[A-Za-z0-9]+)*\s*=\s*)("[^"]*"|'[^']*'|[^\s"';&|]+)/gi, '$1$2' + MARK],
  // Credentials inside a URL.
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@"']+:[^\s/@"']+@/gi, '$1' + MARK + '@'],
  // Tokens recognisable by their own format.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,})\b/g, MARK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, MARK]
];

export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text;
  let result = text;
  for (const [pattern, replacement] of RULES) result = result.replace(pattern, replacement);
  return result;
}

/** A command as stored with a job (`command` text, or `file` with `args`), made fit to show to someone else. */
export function redactCommand(value) {
  if (!value || typeof value !== 'object') return value;
  const shown = { ...value };
  if (typeof shown.command === 'string') shown.command = redactSecrets(shown.command);
  // Arguments are judged together, so that "--token" followed by its value in the next argument is caught.
  if (Array.isArray(shown.args) && shown.args.every(item => typeof item === 'string')) {
    const separator = '\u0000';
    const joined = redactSecrets(shown.args.join(separator)).split(separator);
    shown.args = joined.length === shown.args.length ? joined : shown.args.map(redactSecrets);
  }
  return shown;
}
