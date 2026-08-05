# Runtime hardening test intent

The runtime hardening tests protect failure modes that source-only or package-only checks previously missed:

- concurrent host commands that spawn duplicate Gateways;
- dead Workers whose parent process remains alive;
- startup locks that outlive a crashed host operation;
- silent replacement of corrupt or oversized shared configuration;
- unbounded loopback health responses;
- reload/deactivate paths that restore wrappers before Workers exit;
- packaged VSIX and Obsidian bundles that build but cannot restart cleanly.

Tests should prefer observable contracts: one owner, one matching health endpoint, bounded response bytes, preserved instance ID/token, explicit error codes, removed owner-matched locks, and successful same-port restart.
