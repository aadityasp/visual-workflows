# Component Map (v1)

npm-workspaces monorepo (node 22, npm 10). Final package versions pinned per
stack-validation probe; boundaries below are the contract.

```
visual-workflows/
├─ packages/
│  ├─ protocol/            # @visual-workflows/protocol — THE contract
│  │  ├─ src/events.ts     # envelope + payload types (TS)
│  │  ├─ src/schema.ts     # zod validators (ingestion boundary)
│  │  ├─ src/reduce.ts     # pure reducer: (state, event) -> state
│  │  ├─ src/state.ts      # WorkspaceState types (sessions/workflows/agents/edges)
│  │  ├─ src/infer.ts      # activity inference rules (tool -> activity)
│  │  ├─ src/redact.ts     # secret patterns + entropy scrub (shared)
│  │  └─ test/             # reducer + redaction + schema unit tests
│  │
│  ├─ bridge/              # @visual-workflows/bridge — local server (node)
│  │  ├─ src/server.ts     # http: serves built UI, /ingest, /health; ws: /ws
│  │  ├─ src/bus.ts        # in-proc event bus, seq assignment, ring buffer
│  │  ├─ src/auth.ts       # local token create/verify (0600 file)
│  │  ├─ src/recorder.ts   # opt-in JSONL recordings + retention
│  │  ├─ src/replay.ts     # recording -> event stream with virtual clock
│  │  ├─ src/adapters/
│  │  │  ├─ types.ts       # Adapter interface (start/stop/events out)
│  │  │  ├─ demo/          # scripted demo scenario (labeled source:'demo')
│  │  │  ├─ hooks/         # receiver for the hook forwarder POSTs
│  │  │  └─ transcript/    # ~/.claude tailer: session jsonl + subagents dirs
│  │  │     ├─ watch.ts    # fs watching, incremental line reader
│  │  │     ├─ parse.ts    # jsonl line schemas (tolerant)
│  │  │     └─ map.ts      # lines -> protocol events (TAILER RECIPE impl)
│  │  ├─ src/cli.ts        # `visual-workflows` bin: start|connect|disconnect|wipe
│  │  └─ test/             # adapter mapping + bus + auth tests (vitest)
│  │
│  └─ hook-adapter/        # @visual-workflows/hook-adapter — tiny forwarder
│     └─ src/forward.ts    # stdin json -> redact -> POST 127.0.0.1 -> exit 0 (<2s)
│
├─ apps/
│  └─ ui/                  # @visual-workflows/ui — Vite + React
│     ├─ src/app/          # shell: TopBar, StatusBar, AttentionRail, views
│     ├─ src/canvas/       # React Flow setup, AgentPanel node, FlowEdge,
│     │                    # elk layout runner, minimap, camera control
│     ├─ src/terminal/     # xterm mount (focus view), DOM tail (cards)
│     ├─ src/characters/   # Crew character pack (scout/wrench/beaker/lens):
│     │                    # rig runtime, 14-state contract, pack contract test
│     ├─ src/store/        # zustand stores: connection, workspace, ui prefs
│     ├─ src/replay/       # transport bar, scrubber
│     ├─ src/ws.ts         # socket client (subscribe/snapshot/resume)
│     └─ test/             # component + store tests (vitest + testing-library)
│
├─ plugin/                 # Claude Code plugin: /visual-workflows command +
│                          # hooks entries (thin wrappers over hook-adapter)
├─ examples/
│  └─ recordings/          # sample .jsonl recordings (sanitized, for replay)
├─ docs/                   # PRD, ARCHITECTURE, EVENT_PROTOCOL, UI_SPEC,
│                          # CHARACTER_SYSTEM, SECURITY, ADAPTERS, ROADMAP, ADRs
├─ e2e/                    # Playwright: demo run, replay, a11y smoke
└─ .github/                # CI (format/lint/type/test/build/e2e/audit), templates, workflows
```

## Dependency rules (enforced by convention + lint)

- `protocol` depends on nothing internal. Everyone depends on `protocol`.
- `ui` never imports from `bridge` (talks only via ws protocol).
- `hook-adapter` depends only on `protocol/redact` — it must stay tiny
  (target: no runtime deps, <200 lines) because it runs on every hook fire.
- Adapters implement one interface; deleting an adapter breaks nothing else.

## Real vs simulated (honesty map)

- REAL end-to-end: protocol, reducer, bridge, ws streaming, recorder, replay,
  UI, characters, demo adapter (real events, simulated source — labeled).
- REAL against Claude Code: hooks receiver + transcript tailer (integration
  verified against the local install; marked experimental where the on-disk
  format is undocumented).
- SIMULATED: demo scenario content only.
