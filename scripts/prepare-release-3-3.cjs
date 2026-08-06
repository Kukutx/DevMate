'use strict';

const fs = require('node:fs');

const version = '3.3.0';
const changelogFile = 'CHANGELOG.md';
let changelog = fs.readFileSync(changelogFile, 'utf8');
const heading = `## ${version}`;
if (!changelog.includes(heading)) {
  const marker = '# Changelog\n';
  if (!changelog.startsWith(marker)) throw new Error('Unexpected changelog header');
  const section = [
    '',
    heading,
    '',
    '- Added one owner-aware public tunnel per shared VS Code state directory, so simultaneous ngrok, Cloudflare, or external-provider starts converge instead of creating duplicate provider processes.',
    "- Added follower-safe attachment semantics: attached windows reuse the owner's verified HTTPS URL, while follower Stop and loopback tunnel deletion cannot terminate another window's provider.",
    '- Added pending-owner failover so an attached window re-enters lease-based election once when the first owner exits before readiness, without creating an unbounded restart loop.',
    '- Added atomic, restrictive, versioned tunnel runtime records with configuration fingerprints, future-version preservation, strict validation, malformed/unsafe/oversized quarantine, dead-owner recovery, and path-type protection.',
    '- Added bounded tunnel readiness: provider output inspection is capped at 64 KiB and an owner that does not publish a valid HTTPS URL within 20 seconds is stopped and cleaned.',
    '- Split shared tunnel persistence, process-proxy, and lifecycle coordination into focused modules while preserving the original public runtime exports.',
    '- Replaced the legacy VS Code HTTP accumulator with a reusable client that enforces a four MiB default response bound, a sixteen MiB hard maximum, Content-Length and streamed-size checks, absolute deadlines, and one-shot completion.',
    '- Reduced the shared tunnel heartbeat to once every 30 seconds under a 120-second lease, halving steady-state tunnel metadata writes while retaining four missed-heartbeat intervals before recovery.',
    '- Added Windows and Linux installed-VSIX dual-host tunnel smoke tests plus failover, close-without-exit, recovery-stop, future-record, oversized-response, readiness-timeout, and packaging regression coverage.',
    '',
    ''
  ].join('\n');
  changelog = `${marker}${section}${changelog.slice(marker.length)}`;
  fs.writeFileSync(changelogFile, changelog, 'utf8');
}

const packageFile = 'package.json';
const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
manifest.version = version;
fs.writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
