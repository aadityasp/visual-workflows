# Roadmap

## v0.1.0 — MVP (this build)

- Event protocol + pure reducer + replayable recordings
- Bridge: ws server, ingestion auth, demo adapter, recorder/replay
- Claude Code adapters: hook forwarder + transcript tailer (merge layer)
- Canvas UI: React Flow graph, dagre auto-layout, agent panels, animated
  Crew characters (14 states), attention rail, focus/overview/follow,
  minimap, dark+light, keyboard map, reduced motion
- Demo mode: scripted 7-agent scenario (planner → research → 2 coders ∥ →
  test → review → fix → retest → present)
- `/visual-workflows` Claude Code plugin (command + hooks), `connect`/
  `disconnect` CLI
- Docs, CI, tests (unit + e2e), security review, sample recordings

## v0.2 — Fidelity & trust

- npm publishing: compiled `dist` builds and a real `bin`, so `npx visual-workflows`
  works without a clone (today the CLI runs from a clone via `npm start` / `npm run vw`)
- PermissionRequest/approval flow verified against interactive (non-bypass)
  sessions; approval cards promoted from "experimental"
- OpenTelemetry adapter (OTLP receiver) as third source; cost/token overlays
- Workflow phase bands from `journal.jsonl`/meta (richer gsd labeling)
- Session history browser (past sessions → replay without manual recording)
- Performance hardening: 250+ node stress, edge virtualization

## v0.3 — Reach (the proven expansion path in this niche)

- Codex CLI adapter (`~/.codex/sessions/**/rollout-*.jsonl` tailing)
- Gemini CLI / OpenCode adapters behind the same Adapter interface
- Tauri v2 desktop shell (requires native arm64 toolchain — local node is
  x64-under-Rosetta; build in CI or native node)
- VS Code extension (webview host for the same UI bundle)

## v0.4 — Ecosystem

- Runtime character-pack loading with a sandboxing story; pack gallery
- Lottie pack support; community pack template repo
- Live theming/branding for screen recordings ("presentation mode")
- Multi-machine aggregation (explicitly opt-in networking, off by default)

## Non-goals (standing)

- Driving/steering agents from the UI (would need a new trust boundary)
- Cloud service, accounts, telemetry
