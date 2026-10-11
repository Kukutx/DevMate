import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { spawn } from 'node:child_process';
import { DomainError } from './store.mjs';

// A relay of the owner's own: a public Linux machine they control, on which Caddy terminates TLS for an address that
// stays and forwards what arrives to a loopback port; this computer holds that port open from the inside with an
// OpenSSH remote forward. Nothing in between belongs to a third party, and nothing in between counts requests,
// buffers streams or hands out a new address. DevMate writes no tunnel protocol and no certificate client of its
// own: both jobs are done by programs that do nothing else (OpenSSH, Caddy).
//
// The relay answers only under a path nobody can guess, and by default only to the addresses ChatGPT and Claude
// connect from, plus the address this computer last connected from (so that the route can be checked from here).

const fault = (code, message) => new DomainError(code, message);
// Where Claude's connectors connect from (Anthropic's published range) and where ChatGPT's list is published.
export const ANTHROPIC_RANGES = ['160.79.104.0/21'];
export const OPENAI_RANGES_URL = 'https://openai.com/chatgpt-connectors.json';
const HOST = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

export function relayTarget(value) {
  const [user, host, ...rest] = String(value || '').split('@');
  if (rest.length || !USER.test(user || '') || !(isIP(host || '') === 4 || HOST.test(host || ''))) throw fault('invalid_input', 'Name the server as user@host, for example root@203.0.113.7 or deploy@relay.example.com.');
  return { user, host };
}
export function relaySettings({ target, domain, key = randomBytes(24).toString('base64url'), remotePort = 18443, allowList = true }) {
  const { user, host } = relayTarget(target);
  if (domain !== undefined && !(HOST.test(domain) && domain.includes('.') && !isIP(domain))) throw fault('invalid_input', '--domain is a host name whose DNS record points at the server, for example devmate.example.com.');
  // Without a name of its own the relay is reached by the server's address, which then has to be an address.
  if (!domain && isIP(host) !== 4) throw fault('invalid_input', 'The server is named by a host name: say with --domain which name the relay answers under (it may be the same one).');
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(key)) throw fault('invalid_input', 'The key of a relay is 32 to 64 URL-safe characters.');
  if (!Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535) throw fault('invalid_input', 'The forwarded port is outside its allowed range.');
  const site = domain || host;
  return { user, host, site, byAddress: !domain, key, remotePort, allowList, publicUrl: 'https://' + site + '/mcp/' + key };
}

// The server's side, as one POSIX shell script that can be run again at any time and leaves the same result. It is
// fed to "sh -s" over SSH. DEVMATE_RELAY_ROOT moves every path it writes under another directory, for trying it
// out without being root.
export function relayScript({ site, byAddress, key, remotePort, allowList, user }) {
  const lines = String.raw`#!/bin/sh
set -eu
ROOT="${'$'}{DEVMATE_RELAY_ROOT:-}"
SITE='${site}'
KEY='${key}'
PORT='${remotePort}'
LOGIN='${user}'
ALLOW_LIST='${allowList ? 'yes' : 'no'}'
DIR="$ROOT/etc/caddy/devmate"
LIB="$ROOT/usr/local/lib/devmate"
say() { printf 'devmate-relay: %s\n' "$*"; }
if [ "$(id -u)" -eq 0 ] || [ -n "$ROOT" ]; then AS_ROOT=''; else AS_ROOT='sudo -n'; fi
if [ -n "$AS_ROOT" ] && ! $AS_ROOT true 2>/dev/null; then
  say "error: this needs root. Log in as root, or give $LOGIN sudo without a password."; exit 3
fi

# 1. Caddy, from the system's own packages.
if ! command -v caddy >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then $AS_ROOT env DEBIAN_FRONTEND=noninteractive apt-get update -qq && $AS_ROOT env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy
  elif command -v dnf >/dev/null 2>&1; then $AS_ROOT dnf install -y -q caddy
  elif command -v apk >/dev/null 2>&1; then $AS_ROOT apk add --quiet caddy
  else say 'error: no caddy and no apt-get, dnf or apk to install it with. Install Caddy 2, then run this again.'; exit 4
  fi
  $AS_ROOT touch "$ROOT/etc/caddy/.installed-by-devmate" 2>/dev/null || true
fi
$AS_ROOT mkdir -p "$DIR" "$LIB"
${byAddress ? String.raw`# A certificate for an address instead of a name is something only a recent Caddy can ask for.
VERSION="$(caddy version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -n 1)"
case "$VERSION" in 2.1[0-9]|2.[2-9][0-9]|[3-9].*) ;; *) [ -n "$ROOT" ] || { say "error: this server has Caddy $VERSION, which cannot get a certificate for an IP address (2.10 or newer can). Install a current Caddy (https://caddyserver.com/docs/install), or give the relay a name with --domain."; exit 6; };; esac
` : ''}
# 2. Who may reach the relay: ChatGPT's and Claude's own addresses, and the computer behind it.
#    The published list is kept when it cannot be fetched; a list that is empty or malformed never replaces a good one.
$AS_ROOT tee "$LIB/refresh-allow" >/dev/null <<'REFRESH'
#!/bin/sh
set -eu
DIR="${'$'}{DEVMATE_RELAY_ROOT:-}/etc/caddy/devmate"
NEXT="$(mktemp)"
trap 'rm -f "$NEXT"' EXIT
if curl -fsS --max-time 30 '${OPENAI_RANGES_URL}' | grep -oE '"ipv4Prefix"[[:space:]]*:[[:space:]]*"[0-9./]+"' | grep -oE '[0-9]+(\.[0-9]+){3}/[0-9]+' | sort -u > "$NEXT" && [ "$(wc -l < "$NEXT")" -ge 20 ]; then
  { printf 'remote_ip'; while read -r range; do printf ' %s' "$range"; done < "$NEXT"; printf '\n'; } > "$DIR/openai.ranges"
  if command -v caddy >/dev/null 2>&1 && [ -f "$DIR/site.caddy" ]; then caddy reload --config "${'$'}{DEVMATE_RELAY_ROOT:-}/etc/caddy/Caddyfile" >/dev/null 2>&1 || true; fi
  echo "refreshed: $(wc -l < "$NEXT") ranges"
else
  echo 'kept the previous list: the published one could not be read' >&2
fi
REFRESH
# Run by this computer each time it connects: its own address may change, and the route is checked from there.
$AS_ROOT tee "$LIB/allow-owner" >/dev/null <<'OWNER'
#!/bin/sh
set -eu
DIR="${'$'}{DEVMATE_RELAY_ROOT:-}/etc/caddy/devmate"
ADDRESS="${'$'}{1:-${'$'}{SSH_CLIENT%% *}}"
case "$ADDRESS" in ''|*[!0-9.]*) echo 'no IPv4 client address' >&2; exit 0;; esac
[ "$(cat "$DIR/owner.ranges" 2>/dev/null)" = "remote_ip $ADDRESS" ] && exit 0
printf 'remote_ip %s\n' "$ADDRESS" > "$DIR/owner.ranges"
if command -v caddy >/dev/null 2>&1; then caddy reload --config "${'$'}{DEVMATE_RELAY_ROOT:-}/etc/caddy/Caddyfile" >/dev/null 2>&1 || true; fi
OWNER
$AS_ROOT chmod 755 "$LIB/refresh-allow" "$LIB/allow-owner"
[ -f "$DIR/openai.ranges" ] || printf 'remote_ip 192.0.2.0/32\n' | $AS_ROOT tee "$DIR/openai.ranges" >/dev/null
[ -f "$DIR/owner.ranges" ] || printf 'remote_ip 192.0.2.1/32\n' | $AS_ROOT tee "$DIR/owner.ranges" >/dev/null
printf 'remote_ip ${ANTHROPIC_RANGES.join(' ')}\n' | $AS_ROOT tee "$DIR/anthropic.ranges" >/dev/null
# The login that holds the tunnel keeps its own address current; it needs to write that one file.
$AS_ROOT chown "$LOGIN" "$DIR/owner.ranges" 2>/dev/null || true

# 3. The site: one path is forwarded, unbuffered; everything else does not exist.
if [ "$ALLOW_LIST" = yes ]; then
  GATE="@stranger {
			not {
				import $DIR/openai.ranges
			}
			not {
				import $DIR/anthropic.ranges
			}
			not {
				import $DIR/owner.ranges
			}
		}
		respond @stranger \"devmate-relay: this address is not on the list\" 403"
else GATE='# every address may try: the path is the key'
fi
$AS_ROOT tee "$DIR/site.caddy" >/dev/null <<SITE
# Written by "devmate relay setup". Changes here are replaced the next time it runs.
$SITE {
${byAddress ? '\ttls {\n\t\tissuer acme {\n\t\t\tprofile shortlived\n\t\t}\n\t}\n' : ''}	handle /mcp/$KEY {
		$GATE
		reverse_proxy 127.0.0.1:$PORT {
			flush_interval -1
		}
	}
	handle {
		respond 404
	}
}
SITE
MAIN="$ROOT/etc/caddy/Caddyfile"
[ -f "$MAIN" ] || $AS_ROOT touch "$MAIN"
grep -qF 'import devmate/site.caddy' "$MAIN" || printf '\nimport devmate/site.caddy\n' | $AS_ROOT tee -a "$MAIN" >/dev/null

# 4. Keep the list current, and start.
if [ "$ALLOW_LIST" = yes ]; then
  $AS_ROOT "$LIB/refresh-allow" || true
  if [ -z "$ROOT" ] && command -v systemctl >/dev/null 2>&1; then
    printf '[Unit]\nDescription=Refresh the addresses the DevMate relay answers to\n[Service]\nType=oneshot\nExecStart=%s\n' "$LIB/refresh-allow" | $AS_ROOT tee /etc/systemd/system/devmate-relay-allow.service >/dev/null
    printf '[Unit]\nDescription=Refresh the DevMate relay allow list\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=6h\nPersistent=true\n[Install]\nWantedBy=timers.target\n' | $AS_ROOT tee /etc/systemd/system/devmate-relay-allow.timer >/dev/null
    $AS_ROOT systemctl daemon-reload && $AS_ROOT systemctl enable --now devmate-relay-allow.timer >/dev/null 2>&1 || say 'warning: the timer that refreshes the list could not be started'
  fi
fi
"$LIB/allow-owner" || true
if [ -z "$ROOT" ]; then
  $AS_ROOT caddy validate --config "$MAIN" >/dev/null 2>&1 || { say 'error: Caddy does not accept the configuration:'; $AS_ROOT caddy validate --config "$MAIN" 2>&1 | tail -n 5; exit 5; }
  if command -v systemctl >/dev/null 2>&1; then $AS_ROOT systemctl enable caddy >/dev/null 2>&1 || true; $AS_ROOT systemctl reload caddy 2>/dev/null || $AS_ROOT systemctl restart caddy
  else $AS_ROOT caddy reload --config "$MAIN" 2>/dev/null || $AS_ROOT caddy start --config "$MAIN"
  fi
fi
say "ready: https://$SITE/mcp/<key> forwards to 127.0.0.1:$PORT ($(caddy version 2>/dev/null | head -n 1 || echo 'caddy'))"
`;
  return lines.replace(/\r\n/g, '\n');
}

// Taking the relay off a server again: what setup wrote, and Caddy itself only when setup was what installed it.
export function relayRemovalScript() {
  return String.raw`#!/bin/sh
set -eu
ROOT="${'$'}{DEVMATE_RELAY_ROOT:-}"
say() { printf 'devmate-relay: %s\n' "$*"; }
if [ "$(id -u)" -eq 0 ] || [ -n "$ROOT" ]; then AS_ROOT=''; else AS_ROOT='sudo -n'; fi
if [ -n "$AS_ROOT" ] && ! $AS_ROOT true 2>/dev/null; then say 'error: this needs root.'; exit 3; fi
MAIN="$ROOT/etc/caddy/Caddyfile"
if [ -f "$MAIN" ]; then grep -vF 'import devmate/site.caddy' "$MAIN" | $AS_ROOT tee "$MAIN.devmate-next" >/dev/null && $AS_ROOT mv "$MAIN.devmate-next" "$MAIN"; fi
$AS_ROOT rm -rf "$ROOT/etc/caddy/devmate" "$ROOT/usr/local/lib/devmate"
if [ -z "$ROOT" ] && command -v systemctl >/dev/null 2>&1; then
  $AS_ROOT systemctl disable --now devmate-relay-allow.timer >/dev/null 2>&1 || true
  $AS_ROOT rm -f /etc/systemd/system/devmate-relay-allow.service /etc/systemd/system/devmate-relay-allow.timer
  $AS_ROOT systemctl daemon-reload || true
fi
if [ -f "$ROOT/etc/caddy/.installed-by-devmate" ]; then
  $AS_ROOT rm -f "$ROOT/etc/caddy/.installed-by-devmate"
  if [ -z "$ROOT" ]; then
    if command -v apt-get >/dev/null 2>&1; then $AS_ROOT env DEBIAN_FRONTEND=noninteractive apt-get remove -y -qq caddy || true
    elif command -v dnf >/dev/null 2>&1; then $AS_ROOT dnf remove -y -q caddy || true
    elif command -v apk >/dev/null 2>&1; then $AS_ROOT apk del --quiet caddy || true
    fi
  fi
  say 'removed: the relay, and Caddy, which this had installed'
else
  if [ -z "$ROOT" ] && command -v caddy >/dev/null 2>&1; then $AS_ROOT systemctl reload caddy 2>/dev/null || $AS_ROOT caddy reload --config "$MAIN" 2>/dev/null || true; fi
  say 'removed: the relay. Caddy was here before and stays.'
fi
`.replace(/\r\n/g, '\n');
}

// Run a script on the server through the system's own OpenSSH. Authentication is whatever the owner's SSH already
// uses (agent or key file); a password is never asked for and never handled here.
export function sshOptions({ user, sshPort = 22, identityFile, acceptNewHostKey = false }) {
  return ['-T', '-a', '-F', 'none', '-S', 'none', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
    // The first contact of a setup records the server's key; every later connection insists on that key.
    '-o', 'StrictHostKeyChecking=' + (acceptNewHostKey ? 'accept-new' : 'yes'),
    '-p', String(sshPort), '-l', user, ...(identityFile ? ['-i', identityFile, '-o', 'IdentitiesOnly=yes'] : [])];
}
export function runOverSsh({ executable, host, options, script, command = 'sh -s', spawnImpl = spawn, timeoutMs = 300000, env = process.env }) {
  return new Promise((resolve, reject) => {
    const inherited = new Set(['path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'home', 'userprofile', 'ssh_auth_sock']);
    const child = spawnImpl(executable, [...options, host, command], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.fromEntries(Object.entries(env).filter(([name]) => inherited.has(name.toLowerCase()))) });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill?.(); reject(fault('relay_timeout', 'The server did not finish within ' + Math.round(timeoutMs / 1000) + ' seconds.')); }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk).slice(-64000); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    child.once('error', error => { clearTimeout(timer); reject(fault('ssh_not_started', 'OpenSSH could not be started: ' + error.message)); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin?.on('error', () => {});
    child.stdin?.end(script || '');
  });
}

export async function setupRelay({ target, domain, sshPort = 22, identityFile, executable, allowList = true, key, run = runOverSsh }) {
  const settings = relaySettings({ target, domain, allowList, ...(key ? { key } : {}) });
  const options = sshOptions({ user: settings.user, sshPort, identityFile, acceptNewHostKey: true });
  const result = await run({ executable, host: settings.host, options, script: relayScript(settings) });
  const said = result.stdout.split(/\r?\n/).filter(line => line.startsWith('devmate-relay: ')).map(line => line.slice(15));
  if (result.code !== 0 || !said.some(line => line.startsWith('ready: '))) {
    const reason = said.findLast(line => line.startsWith('error: '))?.slice(7) || result.stderr.trim().split(/\r?\n/).slice(-3).join(' | ') || 'the server script ended with code ' + result.code;
    throw fault(result.code === 255 ? 'ssh_failed' : 'relay_setup_failed', result.code === 255
      ? 'Could not log in to ' + settings.user + '@' + settings.host + ' without a password: ' + reason + '. Set up key login first (ssh-copy-id, or add your public key to ~/.ssh/authorized_keys on the server).'
      : 'The relay was not set up: ' + reason);
  }
  return { ...settings, notes: said, connection: { kind: 'ssh', publicUrl: settings.publicUrl, executable, host: settings.host, user: settings.user, sshPort, remotePort: settings.remotePort,
    ...(identityFile ? { identityFile } : {}) } };
}
export async function removeRelay({ target, sshPort = 22, identityFile, executable, run = runOverSsh }) {
  const { user, host } = relayTarget(target);
  const result = await run({ executable, host, options: sshOptions({ user, sshPort, identityFile }), script: relayRemovalScript() });
  const said = result.stdout.split(/\r?\n/).filter(line => line.startsWith('devmate-relay: ')).map(line => line.slice(15));
  if (result.code !== 0) throw fault('relay_removal_failed', 'The relay was not removed: ' + (said.findLast(line => line.startsWith('error: '))?.slice(7) || result.stderr.trim().split(/\r?\n/).slice(-3).join(' | ') || 'code ' + result.code));
  return { removed: true, notes: said };
}
