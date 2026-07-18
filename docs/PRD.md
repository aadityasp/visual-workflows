# Product Requirements Document (v1 draft)

Name: **visual-workflows** (owner's pick; prior-art probe naming notes will be
presented at the approval gate for a final call). Ships with a Claude Code
plugin exposing the `/visual-workflows` slash command to launch/attach the
dashboard from inside a session.

## One-liner

A local, real-time animated command center for AI coding agent workflows:
watch a team of small AI engineers plan, code, test, and review — as a live
graph of connected terminal panels with expressive status characters.

## Problem

Multi-agent runs in Claude Code (subagents, workflows, /gsd phases) surface as
small expandable rows under the prompt. Understanding a live run means clicking
and hovering tiny targets, one row at a time. There is no way to see the whole
run — who is working, who is blocked, what is parallel, where the failure is —
at a glance, and no way to rewatch a finished run.

## Users

1. **The operator** (primary): a developer running multi-agent workflows who
   wants ambient situational awareness on a second screen; intervenes only when
   something needs them (approval, blocker, failure).
2. **The narrator**: records/demos agent runs (README GIFs, talks, PR context).
3. **The tinkerer** (contributor): wants to feed events from their own agent
   framework and ship custom character packs.

## Jobs to be done

- "Show me everything my agents are doing right now, without clicks."
- "Interrupt me only for approvals, blockers, failures."
- "Let me zoom from the whole run into one agent's terminal instantly."
- "Let me replay what happened after the fact."

## Core principles

1. **Glanceable truth** — the default view answers who/what/status without
   expansion, hover, or tiny targets.
2. **Observation ≠ execution** — the app watches; it never drives the agents.
   Structural separation, not a toggle.
3. **Local-first & private** — no uploads, no analytics by default, secrets
   redacted at the source.
4. **Honest data** — simulated (demo) data is always labeled; observed data
   carries its provenance.
5. **Delight with restraint** — characters and motion communicate state; they
   never obscure it. Reduced-motion mode is first-class.

## MVP scope (must all hold)

1. Starts alongside Claude Code; one documented command runs everything.
2. Detects real workflows via the Claude Code adapter (hooks + transcript tail).
3. Shows the main agent as a panel; subagents appear as connected panels.
4. Sequential vs parallel execution is visually obvious (columns/lanes + edges).
5. Live terminal-style output streams into the correct panel.
6. Animated character per panel reflects lifecycle + activity states
   (idle, waiting, thinking, reading, searching, writing code, running,
   testing, reviewing, blocked, failed, completed).
7. Dependencies render as animated edges (spawn/blocks/feeds/reviews).
8. Failures, blockers, approval requests, and input requests are highlighted
   globally (status rail + panel treatment), never hover-only.
9. Completed work collapses into a summary chip; full log remains one click away.
10. Completed runs persist as replayable recordings (when recording enabled).
11. Demo mode: built-in scripted 7-agent scenario runs with zero setup and no
    Claude Code required; clearly labeled "demo".
12. Zoom/pan canvas, minimap, focus mode, overview mode, dark (primary) +
    light themes, keyboard shortcuts, accessible status (icons + text, not
    color alone).

## Explicit non-goals (v1)

- Driving/steering agents (sending prompts, approving from the app).
- Cloud sync, teams, auth beyond local token.
- Windows support guarantees (macOS/Linux first; Windows best-effort).
- VS Code extension and Tauri desktop shell (roadmap).
- Cost/billing analytics dashboards.

## Success criteria

- A first-time viewer understands a 7-agent demo run within 15 seconds of
  opening the page (no docs).
- Operator can answer "what is blocked and why" in <3 seconds from overview.
- 25 concurrently-active panels stay smooth (target 60fps pan/zoom on an
  M-series Mac; graceful degradation beyond).
- Setup for real Claude Code observation ≤ 2 minutes, fully reversible.
- The demo GIF makes the product self-explanatory in a README.

## Experience quality bar

- No tiny click targets; minimum 32px interactive surfaces.
- No hover-only critical information.
- No modal dialogs in the core loop.
- Stable layout: panels never teleport; layout changes animate purposefully;
  new panels enter without displacing the user's viewport focus.
- Typography-first panel design; output is readable code text, not decoration.
- `prefers-reduced-motion` collapses all ambient animation to state changes.
- Every status has icon + label + shape treatment (color-blind safe).

## Competitive positioning (verified 2026-07-17, 19 projects surveyed)

No existing project fuses live spatial agent graph + per-agent state-driven
animated characters + inline live terminal per node + replay. Closest:
**agent-flow** (1.3k★ — live node canvas + replay, but abstract tool-call
boxes, no characters, side-panel output) and **Claude-Code-Agent-Monitor**
(813★ — DAG/Sankey + replay + one decorative mascot, not per-agent state).
README will position against both explicitly. Our wedge: the animated
per-agent "mission control" experience driven by verified hook/transcript
events, local-first, with replay. Platform risk acknowledged: Claude Code's
native agent view could expand; our differentiation is the experience layer,
multi-CLI roadmap, and replay. Positioning lessons adopted: GIF above the
fold, "local-first, no telemetry" line at top, named architecture diagram
in README (hooks + tailer → bridge → WebSocket → canvas).

## Release definition (v0.1.0)

Public GitHub repo with: working demo mode, Claude Code adapter, replay,
docs (README, architecture, security, contributing), CI green, MIT license,
recorded demo GIF. Ships only after explicit owner approval.
