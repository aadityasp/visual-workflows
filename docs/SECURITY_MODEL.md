# Security & Privacy Model (v1)

## What this app touches

Observed data may include: source code fragments, file paths, shell commands,
terminal output, prompts/summaries, model/token metadata. All of it is
treated as sensitive by default.

## Principles

1. **Local by default.** All processing on-device. The app makes zero network
   requests to non-localhost origins. No telemetry, no analytics, no update
   pings. Two concrete controls back this up:
   - **Content-Security-Policy.** The UI declares a CSP as a
     `<meta http-equiv="Content-Security-Policy">` tag in `apps/ui/index.html`
     (which the bridge serves), and the bridge also sends it as a response
     header. It pins `default-src 'self'` and limits `connect-src` to `'self'`
     plus loopback origins only (`ws://127.0.0.1:*`, `ws://localhost:*`,
     `http://127.0.0.1:*`, `http://localhost:*`); `object-src 'none'`,
     `base-uri 'self'`, `form-action 'none'`.
   - **CI external-origin scan.** A CI step greps the built UI bundle
     (`apps/ui/dist`) after `npm run build` for any `http(s)://` or `ws://`
     origin that is not loopback and fails the build if one appears. A small
     allowlist covers known-safe, non-network strings (e.g. the
     `www.w3.org/2000/svg` XML namespace and license-comment URLs).
2. **Observation is structurally separated from execution.** The bridge and UI
   have no code path that spawns processes from UI input, forwards input to
   Claude Code, or writes outside its own data dir. The WebSocket protocol has
   no executable frame types. **One opt-in exception, off by default:** when the
   user runs `connect --auto-open`, the hook adapter (`packages/hook-adapter/src/forward.mjs`)
   may spawn two local processes on its own — the configured `startCommand` to
   boot the bridge if it is not already up, and a browser opener pointed at the
   loopback dashboard URL. Both are read from the user's own `~/.visual-workflows`
   files (`config.json`, and the bridge's `bridge.json` liveness marker) and
   launched via the shell. This is local, user-initiated automation, not a
   network-reachable control path: nothing on `/ingest` or the WebSocket can
   trigger a spawn, and it stays off unless you pass `--auto-open`. The trust
   boundary is explicit — `~/.visual-workflows/config.json` is trusted input,
   since a local user who can write it can already run commands as you. Adding
   any UI- or network-driven "control" feature would still require a new,
   explicitly documented trust boundary.
3. **Ephemeral by default.** Events live in an in-memory ring buffer.
   Recordings are written only when the user enables recording; retention is
   configurable (`maxRecordings`, `maxAgeDays`); "wipe all data" is one command.
4. **Redact at ingestion.** Secret patterns (AWS, GitHub, Slack, Google,
   OpenAI/Anthropic-style keys, JWTs, PEM blocks, Authorization headers,
   password/token assignments, high-entropy env values) are scrubbed in the
   adapter before events reach the bus, so neither UI nor recordings ever see
   them. Redaction is fail-closed: scrub errors drop the chunk, not the filter.

## Threat model

| Threat                                          | Vector                                                          | Mitigation                                                                                                                                                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exfiltration by the app                         | network calls                                                   | zero external origins, CSP, CI check, OSS auditability                                                                                                                                                                  |
| Another local user reads the stream             | open localhost port                                             | bind 127.0.0.1 only; Host-header allowlist (DNS-rebinding defense) on all HTTP and WS requests; bearer token (0600 file) required for /ws and /ingest; token never in URL of logs                                       |
| Another local process ingests fake events       | open /ingest                                                    | same token; events additionally labeled by adapter identity                                                                                                                                                             |
| Malicious terminal output attacks the UI        | ANSI/HTML injection in observed output                          | never `innerHTML` for output; card tails render as text nodes; xterm.js handles ANSI safely; OSC 8 hyperlinks disabled; control chars stripped in card view                                                             |
| Malicious content in transcripts steers the app | log content interpreted as instructions                         | transcripts are parsed as data with strict schemas; no LLM in the loop; unknown shapes dropped with adapter_notice                                                                                                      |
| Secrets end up in recordings                    | observed env/command output                                     | ingestion-time redaction (above) + recording is opt-in + docs warn about residual risk                                                                                                                                  |
| Supply chain                                    | deps                                                            | lockfile, `npm audit` in CI, minimal dep tree, no postinstall scripts policy, pinned versions                                                                                                                           |
| Auto-open spawns local processes                | `--auto-open` reads `~/.visual-workflows/*.json` and shells out | opt-in (off unless `--auto-open`); config/marker files are same-user-writable trusted input; port is parsed as an integer, URL defaults to `http://127.0.0.1:<port>`; unreachable from the network or WebSocket surface |
| Third-party character packs execute code        | pack modules                                                    | v1 ships only built-in packs; runtime pack loading deferred until sandboxed (documented limitation)                                                                                                                     |

Out of scope (documented honestly): a malicious process running as the same
user can already read ~/.claude transcripts directly — we do not claim to
protect against same-user local malware; we simply avoid widening that surface
(no new copies of data at rest by default, 0600 perms on anything we do write).

## Hook adapter safety

The hook command we install is a single small script that: reads stdin JSON,
redacts, POSTs to 127.0.0.1 with the local token, exits 0 **always** (never
blocks or fails a Claude Code action), with a hard self-timeout < 2s. Install
and uninstall are explicit user commands that print the exact settings diff
before writing, back up the previous settings file, and never touch anything
else in settings.

## Disclosure

SECURITY.md in-repo: private reporting via GitHub security advisories,
response-time commitment, supported-versions table (latest minor only).
