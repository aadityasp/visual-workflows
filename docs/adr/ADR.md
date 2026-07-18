# Architecture Decision Records

All decisions verified against the local environment (Claude Code v2.1.212
arm64, node 22.22.0, npm 10.9.4, macOS 26.2 arm64) and live registries on
2026-07-17. Discovery evidence: docs/discovery/ probe reports.

## ADR-001: Local web app served by a Node bridge; no Electron/Tauri in v1

**Decision**: Browser dashboard (Vite+React) served by a local Node "bridge"
process. Tauri v2 desktop shell is roadmap (cargo 1.96 present, feasible).
**Why**: Smallest reliable architecture that delivers the full experience;
zero native build complexity for contributors; `npx`-style one-command start
is the proven adoption pattern in this niche (ccusage lesson). Electron adds
~200MB and a second process model for no v1 gain.
**Tradeoff**: No dock icon/global shortcuts; acceptable for a monitor that
lives on a second screen. Note: local node is x64-under-Rosetta — pure-JS
stack unaffected; Tauri phase must build arm64 natively (flagged in ROADMAP).

## ADR-002: Dual adapter — hooks (push) + transcript tailer (pull), merged

**Decision**: Two independent, complementary Claude Code adapters feeding one
event bus, correlated by `session_id` + `tool_use_id`:

1. **Hook forwarder** (empirically verified against v2.1.212): registered via
   `settings.json`/plugin; receives SessionStart/UserPromptSubmit/PreToolUse/
   PostToolUse/SubagentStart/SubagentStop/Stop/SessionEnd JSON on stdin;
   POSTs to the bridge. Gives real-time lifecycle + tool telemetry +
   subagent attribution (`agent_id`/`agent_type` fields).
2. **Transcript tailer** (schema reverse-engineered and verified): watches
   `~/.claude/projects/<slug>/` — session JSONL (incremental flush verified),
   `subagents/agent-*.jsonl` + `.meta.json`, `subagents/workflows/wf_*/`
   (+ `journal.jsonl`), and `~/.claude/sessions/<pid>.json` (O(1) busy/idle
   liveness registry). Gives output text, thinking, file diffs
   (`toolUseResult.structuredPatch`), token usage, errors, compaction,
   interrupts — detail hooks never see.
   **Why both**: hooks are low-latency and fire for subagent inner tool calls,
   but see no output text or token data; the tailer sees everything but is
   undocumented-format (version fragility). Each covers the other's gap; either
   alone still yields a working (degraded) product. Demo mode needs neither.
   **Tradeoff**: A dedupe/merge layer (keyed on `tool_use_id`) is extra
   complexity — contained in one bridge module (`adapters/merge`).

## ADR-003: UI state is a pure reducer over an append-only event log

**Decision**: `WorkspaceState = reduce(events)` in `packages/protocol`;
live view, snapshots, replay, and scrubbing all run the same reducer.
**Why**: Replay becomes free (a recording IS the event list); testing is
trivial (fixtures in → state out); the bridge stays dumb (sequencing +
fan-out only).
**Tradeoff**: Reducer must be fast (called per event); mitigated with rAF
batching client-side and snapshot frames on subscribe.

## ADR-004: Stack pins (validated against npm registry + peer ranges)

react/react-dom 19.2.7 · vite 8.1.5 · @vitejs/plugin-react 6.0.3 ·
@xyflow/react 12.11.2 · zustand 5.0.14 · @xterm/xterm 6.0.0 (+fit 0.11.0)
· @dagrejs/dagre 3.0.0 · ws 8.21.1 · zod 4.4.3 · vitest 4.1.10 ·
@playwright/test 1.61.1 · eslint 10.7.0 + typescript-eslint 8.64.0 ·
prettier 3.9.5 · tsx 4.23.1 · concurrently 10.0.3 · **typescript 6.0.3**.
**Critical pin**: npm's `typescript@latest` is 7.0.2 (Go rewrite);
typescript-eslint peer range is `<6.1.0` → pinning latest silently breaks
typed linting. CI asserts the TS version. Exact pins everywhere
(`save-exact`); Prettier's own docs recommend it.

## ADR-005: dagre over elkjs for graph layout

**Decision**: `@dagrejs/dagre`, `rankdir: LR`.
**Why**: Synchronous relayout suits a canvas that re-lays-out as nodes
stream in; it's the engine React Flow's own ranked-layout examples use;
smaller bundle. elkjs (async, worker-recommended, 0.x) is justified only by
compound nodes / heavy edge-crossing minimization — revisit if phase-grouped
nesting outgrows dagre (noted in ROADMAP).

## ADR-006: npm workspaces (no pnpm, no turborepo)

Empirically verified working on this machine (symlinks, `-w` scoping,
cross-workspace imports). Fewest tools a contributor must install: node 22
is the only prerequisite.

## ADR-007: WebSocket (ws) for UI transport; HTTP POST for hook ingestion

Node 22 has no built-in server-side WebSocket — `ws` is required and
battle-tested. SSE rejected: we want a single duplex channel for
subscribe/resume semantics. Hook forwarder uses plain HTTP POST (fire-and-
forget, curl-able, no ws client dep in the hot path — the forwarder must
stay tiny and exit <2s, always 0).

## ADR-008: Observation-only protocol (no control plane)

No frame in the ws protocol executes anything; the bridge never spawns
processes from network input (the CLI's own commands are argv-driven only).
Approving/steering agents from the UI is explicitly out of scope until it
can be designed as a separate, opt-in trust boundary. (SECURITY_MODEL.md.)

## ADR-009: Characters are pure SVG+CSS, packs compiled-in for v1

CSS-compositor animation (transform/opacity), no JS animation loop, no
Lottie runtime dep in v1, `prefers-reduced-motion` first-class. Runtime
third-party pack loading deferred (unsandboxed module execution — security).

## ADR-010: Name — visual-workflows

Owner's pick (memorable-brand alternates from the naming probe: murmuration,
swarmscope, swarmdeck — hard blocks found on crewdeck/agentdeck/antfarm/
waggle/termhive). `visual-workflows` is collision-light, descriptive, and
maps 1:1 to the `/visual-workflows` slash command shipped by the plugin.
Final GitHub/npm re-check happens at the publish gate.

## ADR-011: Honest-data rule is part of the architecture

Every event carries `source` ('hook' | 'transcript' | 'demo' | 'replay');
the UI renders a permanent DEMO badge for demo sessions. Simulated data can
never masquerade as observation. (This is also the README disclosure.)
