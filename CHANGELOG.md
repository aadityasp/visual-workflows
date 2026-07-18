# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-17

Initial release.

### Added

- **Event protocol v1** (`@visual-workflows/protocol`): typed event envelope + payloads, zod
  runtime validation at the ingestion boundary (tolerant reader: unknown types/fields pass
  through), pure deterministic reducer (`state = reduce(events)`), activity inference rules,
  and shared secret redaction (pattern + entropy passes, fail-closed).
- **Bridge** (`@visual-workflows/bridge`): localhost-only server with token-gated HTTP `/ingest`
  and WebSocket `/ws`, per-session event sequencing, in-memory ring buffer, snapshot-then-stream
  subscribe with gapless `fromSeq` resume, opt-in JSONL recorder and replay with virtual clock,
  and the `visual-workflows` CLI (`start`, `connect`, `disconnect`, `wipe`).
- **Claude Code adapters**: hook forwarder (real-time lifecycle + tool telemetry; reversible
  `connect`/`disconnect` that prints the settings diff and backs up settings) and transcript
  tailer (output text, file diffs, token usage, subagent and workflow correlation), merged and
  deduped by `tool_use_id`. Empirically verified against Claude Code v2.1.212; version-fragile
  details documented in `docs/ADAPTERS.md`.
- **Canvas UI** (`@visual-workflows/ui`): React Flow canvas with auto-layout (parallel agents
  stack in the same column), agent panels with live output tails, animated dependency edges,
  attention rail for approvals/blockers/failures/input, focus mode with full xterm terminal,
  follow mode, minimap, dark + light themes, keyboard map, and first-class
  `prefers-reduced-motion` support.
- **Crew character pack**: four original SVG+CSS characters (Scout, Wrench, Beaker, Lens) with
  14 state animations driven by agent lifecycle + activity.
- **Demo mode**: built-in scripted 7-agent scenario, zero setup, permanently labeled DEMO.
- **Replay**: recordings are the raw event log; scrubber and speed controls run the same reducer
  as the live view. Sample recording in `examples/recordings/sample-mini.jsonl`.
- **Claude Code plugin**: `/visual-workflows` slash command + hook entries.
- **Docs**: README, architecture, event protocol, adapters, character system, security model,
  roadmap, ADRs, contributing guide.
- **CI**: format check, lint, typecheck, TS-version guard, unit tests, build, external-origin
  scan of the built UI bundle, Playwright e2e (non-blocking while stabilizing), npm audit.

### Security

- Local-first by design: no non-localhost network requests, no telemetry.
- Ingestion-time secret redaction; observation-only WebSocket protocol (no executable frames).

[Unreleased]: https://github.com/aadityasp/visual-workflows/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aadityasp/visual-workflows/releases/tag/v0.1.0
