# UI Layout Specification (v1)

Design language: **quiet operations room**. A dark, focused space where motion
means information. Not an admin dashboard: no card grids of KPIs, no sidebar
tree of settings. One canvas, one attention rail, nothing else at rest.

## Global layout

```
┌────────────────────────────────────────────────────────────┐
│ TopBar: wordmark · session picker · live/replay badge ·    │
│         view toggles · theme · shortcuts hint       (48px) │
├──────────────────────────────────────────┬─────────────────┤
│                                          │ Attention Rail  │
│                                          │ (280px, only    │
│              Workflow Canvas             │  when non-empty)│
│        (zoom/pan, auto-layout)           │ · approvals     │
│                                          │ · blockers      │
│                                          │ · failures      │
│                                          │ · input needed  │
├──────────────────────────────────────────┴─────────────────┤
│ StatusBar: agent counts by state · elapsed · event rate ·  │
│            connection state · minimap toggle        (32px) │
└────────────────────────────────────────────────────────────┘
```

- **Attention Rail** is the only interruption surface: approval requests,
  blockers, failures, input requests as large (≥56px) cards; clicking flies
  the camera to the agent. Rail hidden when empty — calm by default.
- Minimap: bottom-right overlay, toggleable, shows viewport + state-colored
  node dots.

## Views

1. **Overview** (default): whole graph fitted. Auto-refit on topology change
   only if the user hasn't manually moved the camera in the last 10s
   (never fight the user's viewport).
2. **Follow mode**: camera gently tracks the most recently active agent;
   toggled with `f`; any manual pan exits follow.
3. **Focus mode**: one agent maximized — full xterm terminal, metadata column
   (files touched, tool calls, children, tokens, retries). Enter: double-click
   panel or `Enter` on selected. Exit: `Esc`. Others dim to 20% (still visible
   for context).
4. **Fullscreen**: browser fullscreen of any view (`shift+f`).
5. **Replay**: identical canvas plus a transport bar (play/pause, speed
   1×/4×/16×/max, seek-by-seq scrubber with event-density sparkline).

## Canvas & layout

- Engine: React Flow (`@xyflow/react`) with a custom node type (AgentPanel)
  and custom edge (FlowEdge).
- Auto-layout: ELK layered algorithm, left→right rank = execution order.
  Parallel agents share a rank → they stack vertically in the same column,
  making parallelism literally visible as a column of simultaneous panels.
- Workflow phases render as subtle labeled background bands behind their rank
  range (e.g. "Discover", "Verify").
- Dragging a panel pins it (pin badge appears); auto-layout respects pins;
  "reset layout" un-pins all.
- Edges: `spawns` solid, `feeds` animated directional dash flow while data is
  moving, `blocks` shows a lock glyph at the blocked end, `reviews` dotted
  with a magnifier glyph at midpoint. Active edges glow slightly.
- Panel enter: scale 0.96→1 + fade over 200ms, camera does NOT jump.
  Completion: panel morphs (250ms height collapse) into its summary chip.

## AgentPanel anatomy (default card ~360×230)

```
┌─ [◐ character 44px] Planner · gsd-planner ─── 02:41 ─ ● Thinking ─┐
│ current action line ("Reading src/state/reducer.ts")              │
│ ┌───────────────────────────────────────────────────────────────┐ │
│ │ tail of output — last 6 lines, monospace 12px, dim scrollback │ │
│ └───────────────────────────────────────────────────────────────┘ │
│ ⛿ 3 files · ⚙ 12 tools · ↳ 2 children · ⟳ 1 retry · ▓▓░ 41k tok  │
└───────────────────────────────────────────────────────────────────┘
```

- Header: character (state-animated), name, agentType chip, elapsed timer,
  status chip (icon + label — never color alone).
- Body: one-line **current action** (derived from latest tool event), then a
  6-line live output tail (plain DOM, not xterm — cheap at scale).
- Footer: compact fact chips; only chips with data render.
- Expanded (in-canvas resize or focus mode): full xterm.js terminal with
  scrollback, plus tabs: Output · Files · Tools · Details (parent, children,
  dependencies, model, error detail with stack when failed).
- Completed chip state: 56px row — character (rest pose), name, duration,
  one-line summary, expand affordance.
- Failed: panel keeps full size, error summary replaces action line, red
  broken-ring status; never auto-collapses.

## Status system (accessible)

| State             | Icon             | Shape treatment            | Motion (full)              | Reduced motion |
| ----------------- | ---------------- | -------------------------- | -------------------------- | -------------- |
| idle/waiting      | ◌ hollow ring    | dim border                 | slow breathe               | static dim     |
| thinking          | ◐                | soft border pulse          | orbiting dots              | static badge   |
| reading           | ▤                | —                          | scanline sweep             | static badge   |
| searching         | ⌕                | —                          | lens sweep                 | static badge   |
| writing code      | ⌨                | —                          | typing ticks               | static badge   |
| running command   | ▶                | —                          | activity pulse             | static badge   |
| testing           | ⚗                | —                          | beaker bubble              | static badge   |
| reviewing         | 🔍̶ (glyph)       | —                          | magnifier arc              | static badge   |
| blocked           | ⛔-style octagon | amber left bar             | none (static = calm alarm) | same           |
| awaiting approval | ✋               | amber left bar + rail card | gentle attention ring      | static         |
| failed            | ⨯ broken ring    | red left bar + rail card   | one-shot shake ≤300ms      | static         |
| completed         | ✓ seal           | green tint                 | one-shot check draw        | static         |

All states expose `aria-label` text; the character is `aria-hidden` decoration.

## Keyboard

`?` shortcuts overlay · `o` overview/fit · `f` follow · `Enter` focus selected ·
`Esc` back · `Tab`/arrows cycle agents · `1..9` jump to attention items ·
`m` minimap · `t` theme · `space` (replay) play/pause · `←/→` (replay) step ·
`shift+f` fullscreen · `cmd/ctrl+k` command palette (session switch, actions).

## Theming

- Dark primary: near-black desaturated blue (#0B0E14 range), panels one step
  lighter with 1px inner hairline, text #E6EAF2, dim #8A93A6.
- Semantic accents only: running/info cyan-blue, success green, warning amber,
  danger red, thinking violet. Role accent tints the character, not the panel.
- Light mode: same structure, paper-gray canvas, identical semantic hues
  (AA contrast in both).
- Fonts: UI = Inter var (system-ui fallback); output = "JetBrains Mono",
  SF Mono, Menlo fallback stack (self-hosted, no CDN).

## Glass panels & per-panel minimize/expand (owner directive, 2026-07-17)

- **Translucent panels**: agent cards and the focus terminal use a
  semi-transparent background with backdrop blur (dark:
  rgba(panel, ~0.72) + `backdrop-filter: blur(10px) saturate(1.2)`; light
  theme equivalent) so the canvas background — grid, edges, phase bands —
  stays visible through every panel. Hairline borders remain for edge
  definition. Fallbacks: `@supports not (backdrop-filter)` and
  `prefers-reduced-transparency` get a solid panel background; text
  contrast must stay AA in all modes.
- **Always-visible per-panel controls** (≥32px hit targets, in the card
  header): **minimize** (collapse any agent — not just completed ones — to
  its compact chip row; click/restore toggles back) and **expand** (open
  focus-mode full terminal). Double-click and Enter still work; the buttons
  make the affordance discoverable without hover or keyboard knowledge.
- Minimized chips keep character + name + status chip so a fully minimized
  board still reads at a glance.
- xterm in focus view: `allowTransparency` with a slightly translucent
  background, dimmed canvas visible behind the overlay.

## Performance strategy

- xterm.js instances ONLY in focus/expanded view (1-2 mounted max);
  default tails are sliced-array DOM text.
- Per-agent output ring buffer (5,000 lines in memory, 6 in card DOM);
  full scrollback streamed to focus terminal on demand.
- Event application batched per animation frame; reducer emits patches;
  Zustand store with per-panel selectors to avoid canvas-wide re-renders.
- React Flow `onlyRenderVisibleElements`; edges on a single SVG/canvas layer;
  ambient animations via CSS transform/opacity only (GPU-composited).
- Soft cap tested target: 100 total nodes / 25 concurrently animating.
