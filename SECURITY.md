# Security Policy

visual-workflows observes coding sessions, which means it handles source code fragments, file
paths, shell commands, terminal output, and prompt text. All of it is treated as sensitive by
default. The full design is in [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md); this file covers
reporting and the honest boundaries.

## Supported versions

Only the latest minor release receives security fixes.

| Version              | Supported |
| -------------------- | --------- |
| 0.1.x (latest minor) | Yes       |
| Anything older       | No        |

## Reporting a vulnerability

Please report vulnerabilities **privately via GitHub Security Advisories** ("Report a
vulnerability" on the repo's Security tab). Do not open a public issue for security reports.

Commitment: we acknowledge reports within **72 hours**, keep you updated as we investigate, and
credit reporters in the fix release notes unless you prefer otherwise.

## Scope

In scope, and where reports are most valuable:

- **The localhost bridge**: the `/ingest` HTTP endpoint and `/ws` WebSocket. It must bind
  `127.0.0.1` only and require the per-install bearer token (0600 token file). Anything that lets
  a non-token-holder read the event stream, inject events, or make the bridge do more than
  observe-and-fan-out is a vulnerability.
- **Observation/execution separation**: the protocol has no frame that executes anything. Any code
  path from network input to process spawning, file writes outside the app's data dir, or input
  forwarded into Claude Code is a vulnerability by definition.
- **Redaction**: secret patterns (cloud keys, tokens, JWTs, PEM blocks, auth headers, high-entropy
  assignments) are scrubbed at ingestion, fail-closed. Bypasses that get a real credential shape
  into the UI or a recording are in scope.
- **Rendering of hostile terminal output**: observed output is attacker-influenced text; ANSI/HTML
  injection that escapes the text rendering path is in scope.
- **The hook forwarder**: it must never block or fail a Claude Code action (always exit 0, hard
  timeout) and must not widen what is readable on the machine.
- Supply chain: dependency pinning, no postinstall scripts, `npm audit` cleanliness.

## Known limitations (honest)

These are accepted boundaries, documented rather than claimed away:

- **Same-user local processes are not our adversary.** A malicious process running as your user
  can already read `~/.claude` transcripts directly; that data is same-user readable before we
  ever touch it. Our token protects the loopback stream from _other_ users and casual port
  scanning, but the token file itself is readable by your user, so same-user malware can read the
  WebSocket stream too. We avoid widening that surface (no new copies of data at rest by default,
  0600 permissions on everything we write), we do not eliminate it.
- **Redaction is best-effort pattern matching.** It cannot recognize every credential format and
  cannot classify proprietary code as secret. Recordings are opt-in for exactly this reason;
  review them before sharing.
- **Claude Code's hook payloads and transcript format are not a stable API.** Parsers are
  tolerant and validated per verified version, but a format change could cause missed (never
  fabricated) events until re-verified.
