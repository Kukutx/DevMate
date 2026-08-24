import path from 'node:path';

export const SENSITIVE_DIRECTORY_SEGMENTS = new Set([
  '.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.npm', '.m2', '.gradle',
  '.terraform', '.pulumi', '.serverless', '.wrangler', '.direnv', '.devmate', '.codex', '.openai',
  'secrets', 'secret', 'credentials', 'credential', 'private-key', 'private_keys',
  'service-account', 'service_accounts'
]);

export const SENSITIVE_BASENAMES = new Set([
  '.env', '.envrc', '.dev.vars', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', '.netrc', '_netrc',
  '.git-credentials', '.gitconfig', '.sentryclirc', '.terraformrc', 'terraform.rc',
  'pip.conf', 'nuget.config', 'local.properties', 'keystore.properties', 'key.properties', 'gradle.properties',
  'credentials.json', 'credential.json', 'secrets.json', 'secret.json',
  'service-account.json', 'service_account.json', 'service-account-key.json', 'service_account_key.json',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'
]);

export const SENSITIVE_EXTENSIONS = new Set([
  '.pem', '.key', '.pfx', '.p12', '.jks', '.keystore', '.db', '.sqlite', '.sqlite3', '.log'
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

export function relativePathParts(value) {
  return slash(value).split('/').filter(Boolean);
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
  const parts = relativePathParts(value);
  if (!parts.length) return '';
  const lowered = parts.map(part => part.toLowerCase());
  const sensitiveDirectory = lowered.find(part => SENSITIVE_DIRECTORY_SEGMENTS.has(part));
  if (sensitiveDirectory) return `sensitive-directory:${sensitiveDirectory}`;

  const base = lowered.at(-1) || '';
  if (isEnvironmentCredentialFile(base)) return 'environment-credential';
  if (SENSITIVE_BASENAMES.has(base)) return `sensitive-basename:${base}`;
  if (SENSITIVE_EXTENSIONS.has(path.posix.extname(base).toLowerCase())) return `sensitive-extension:${path.posix.extname(base).toLowerCase()}`;

  const dockerIndex = lowered.lastIndexOf('.docker');
  if (dockerIndex >= 0 && dockerIndex < lowered.length - 1 && base === 'config.json') {
    return 'docker-credential-config';
  }
  return '';
}

export function isSensitiveWorkspacePath(value) {
  return !!sensitiveWorkspacePathReason(value);
}

export function isSafeWorkspaceTextPath(value) {
  if (isSensitiveWorkspacePath(value)) return false;
  const normalized = slash(value);
  const base = path.posix.basename(normalized);
  if (SAFE_TEXT_BASENAMES.has(base)) return true;
  if (isSafeEnvironmentExample(base)) return true;
  return SAFE_TEXT_EXTENSIONS.has(path.posix.extname(base).toLowerCase());
}
