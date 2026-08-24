import path from 'node:path';

export const SENSITIVE_DIRECTORY_SEGMENTS = new Set([
  '.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.npm', '.m2', '.gradle',
  '.terraform', '.pulumi', '.serverless', '.wrangler', '.direnv', '.devmate', '.devmate-server', '.codex', '.openai',
  'secrets', 'secret', 'credentials', 'credential', 'private-key', 'private_keys',
  'service-account', 'service_accounts'
]);

export const SENSITIVE_BASENAMES = new Set([
  '.env', '.envrc', '.dev.vars', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', '.netrc', '_netrc',
  '.git-credentials', '.gitconfig', '.sentryclirc', '.terraformrc', 'terraform.rc', '.htpasswd', '.htdigest',
  '.credentials', '.secrets', 'auth.json', 'master.key', 'application_default_credentials.json',
  'oauth-secrets.json', 'pip.conf', 'nuget.config', 'local.properties', 'keystore.properties', 'key.properties', 'gradle.properties',
  'credentials.json', 'credential.json', 'secrets.json', 'secret.json',
  'service-account.json', 'service_account.json', 'service-account-key.json', 'service_account_key.json',
  'serviceaccountkey.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'
]);

export const SENSITIVE_EXTENSIONS = new Set([
  '.pem', '.key', '.pfx', '.p12', '.jks', '.keystore', '.db', '.sqlite', '.sqlite3', '.log'
]);

export const SAFE_PROJECT_METADATA_PATHS = new Set([
  '.devmate/automation.json'
]);

export const SAFE_TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.json', '.jsonc', '.yaml', '.yml', '.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs',
  '.css', '.scss', '.sass', '.less', '.html', '.xml', '.cs', '.csproj', '.sln', '.dart', '.py', '.ps1', '.sh',
  '.bash', '.zsh', '.sql', '.toml', '.ini', '.config', '.cfg', '.props', '.targets', '.java', '.kt', '.kts', '.go',
  '.rs', '.php', '.rb', '.swift', '.vue', '.svelte', '.gd', '.godot', '.gdshader', '.gdshaderinc', '.shader',
  '.tscn', '.tres', '.uid'
]);

export const SAFE_TEXT_BASENAMES = new Set([
  'README', 'README.md', 'LICENSE', 'Dockerfile', 'Makefile', 'CMakeLists.txt',
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'pubspec.yaml', 'pubspec.lock', 'global.json', 'Directory.Packages.props',
  'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig',
  '.prettierignore', '.eslintignore', '.npmignore', '.nvmrc', '.node-version', '.python-version', '.tool-versions',
  'Gemfile', 'Rakefile', 'Pipfile', 'Pipfile.lock', 'go.mod', 'go.sum', 'Cargo.lock',
  'Package.resolved', 'Podfile', 'Podfile.lock'
]);

function slash(value) {
  return String(value || '').replace(/\\/g, '/');
}

function normalizedRelative(value) {
  return slash(value).replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

export function relativePathParts(value) {
  return normalizedRelative(value).split('/').filter(Boolean);
}

function hasSensitiveParent(parts, endExclusive) {
  return parts.slice(0, endExclusive).some(part => SENSITIVE_DIRECTORY_SEGMENTS.has(part));
}

export function isSafeGodotBaselineMetadataPath(value) {
  const lowered = relativePathParts(value).map(part => part.toLowerCase());
  if (lowered.length < 4) return false;
  const file = lowered.at(-1) || '';
  const markerStart = lowered.length - 4;
  if (lowered[markerStart] !== '.devmate' || lowered[markerStart + 1] !== 'baselines' || lowered[markerStart + 2] !== 'godot') return false;
  if (hasSensitiveParent(lowered, markerStart)) return false;
  if (!/^[a-z0-9._-]{1,160}\.json$/.test(file)) return false;
  if (SENSITIVE_BASENAMES.has(file) || /^service[_-]?account(?:[_-]?key)?.*\.json$/i.test(file)) return false;
  return true;
}

export function isSafeProjectMetadataPath(value) {
  const parts = relativePathParts(value);
  if (parts.length < 2) return false;
  const lowered = parts.map(part => part.toLowerCase());
  if (isSafeGodotBaselineMetadataPath(value)) return true;
  for (const safe of SAFE_PROJECT_METADATA_PATHS) {
    const safeParts = safe.split('/').filter(Boolean);
    if (safeParts.length > lowered.length) continue;
    const start = lowered.length - safeParts.length;
    if (!safeParts.every((part, index) => lowered[start + index] === part)) continue;
    if (!hasSensitiveParent(lowered, start)) return true;
  }
  return false;
}

export function isSafeEnvironmentExample(base) {
  const value = String(base || '').toLowerCase();
  return value.endsWith('.env.example') || value.endsWith('.env.sample') || value.endsWith('.env.template');
}

export function isEnvironmentCredentialFile(base) {
  const value = String(base || '').toLowerCase();
  if (isSafeEnvironmentExample(value)) return false;
  return value === '.env' || value === '.envrc' || value === 'env.local' ||
    value.startsWith('.env.') || value.endsWith('.env') || value === '.dev.vars';
}

export function sensitiveWorkspacePathReason(value) {
  const normalized = normalizedRelative(value);
  if (!normalized || normalized === '.') return '';
  if (isSafeProjectMetadataPath(normalized)) return '';
  const parts = relativePathParts(normalized);
  if (!parts.length) return '';
  const lowered = parts.map(part => part.toLowerCase());
  const sensitiveDirectory = lowered.find(part => SENSITIVE_DIRECTORY_SEGMENTS.has(part));
  if (sensitiveDirectory) return `sensitive-directory:${sensitiveDirectory}`;

  const base = lowered.at(-1) || '';
  if (isEnvironmentCredentialFile(base)) return 'environment-credential';
  if (SENSITIVE_BASENAMES.has(base)) return `sensitive-basename:${base}`;
  if (/^service[_-]?account(?:[_-]?key)?.*\.json$/i.test(base)) return 'service-account-credential';
  if (SENSITIVE_EXTENSIONS.has(path.posix.extname(base).toLowerCase())) return `sensitive-extension:${path.posix.extname(base).toLowerCase()}`;

  const dockerIndex = lowered.lastIndexOf('.docker');
  if (dockerIndex >= 0 && dockerIndex < lowered.length - 1 && base === 'config.json') {
    return 'docker-credential-config';
  }
  return '';
}

export function assertSafeWorkspacePath(value, label = 'Workspace path') {
  const reason = sensitiveWorkspacePathReason(value);
  if (!reason) return value;
  const error = new Error(`${label} targets protected workspace data (${reason}): ${normalizedRelative(value)}`);
  error.code = 'protected_workspace_path';
  error.reason = reason;
  throw error;
}

export function isSensitiveWorkspacePath(value) {
  return !!sensitiveWorkspacePathReason(value);
}

export function isSafeWorkspaceTextPath(value) {
  if (isSensitiveWorkspacePath(value)) return false;
  const normalized = normalizedRelative(value);
  if (isSafeProjectMetadataPath(normalized)) return true;
  const base = path.posix.basename(normalized);
  if (SAFE_TEXT_BASENAMES.has(base)) return true;
  if (isSafeEnvironmentExample(base)) return true;
  return SAFE_TEXT_EXTENSIONS.has(path.posix.extname(base).toLowerCase());
}
