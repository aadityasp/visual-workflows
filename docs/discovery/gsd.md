# GSD (get-shit-done) Internals — Read-Only Documentation Report

Sources read in full: `<HOME>/.claude/commands/gsd/execute-phase.md`, `plan-phase.md`, `new-project.md`; `<HOME>/.claude/get-shit-done/workflows/execute-phase.md`; all 11 agent files in `<HOME>/.claude/agents/gsd-*.md`; `<HOME>/.claude/get-shit-done/references/{ui-brand,model-profiles,checkpoints,continuation-format,planning-config}.md`; `<HOME>/.claude/get-shit-done/templates/{state,summary,config.json,roadmap}.md`; `<HOME>/.claude/hooks/{gsd-check-update.js,gsd-statusline.js}`; `<HOME>/.claude/get-shit-done/VERSION` (currently `1.9.13`). No files were modified during this investigation.

---

## 1. Architecture: How Commands Orchestrate

GSD is a **slash-command-driven, file-state-backed multi-agent workflow system** built entirely on Claude Code primitives — no external server, no daemon. Everything lives in `~/.claude/commands/gsd/*.md` (27 slash commands), `~/.claude/agents/gsd-*.md` (11 subagent definitions), `~/.claude/get-shit-done/` (shared references/templates/workflows), and a per-project `.planning/` directory that is the durable state store.

### 1.1 Command → orchestrator → subagent pattern

Every `/gsd:*` command is a markdown file with YAML frontmatter (`name`, `description`, `argument-hint`, `allowed-tools`, occasionally `agent:`) followed by an `<objective>`, `<execution_context>` (an `@`-include list of shared reference docs), `<context>`, `<process>` (numbered steps), `<offer_next>` (post-completion routing), and `<success_criteria>`.

The **command itself runs in the main conversation thread as the orchestrator** — it is not a subagent. It stays context-lean (~10-15%) and delegates heavy work via the `Task` tool to subagents (`subagent_type: gsd-executor`, `gsd-planner`, etc., or generically `general-purpose` with an inline instruction "First, read `<HOME>/.claude/agents/gsd-XXX.md` for your role").

Two spawn idioms appear:

- **Direct**: `Task(prompt=..., subagent_type="gsd-executor", model="sonnet")` — used for executor, verifier, plan-checker, roadmapper, codebase-mapper, integration-checker, debugger.
- **Bootstrapped generic**: `Task(prompt="First, read <HOME>/.claude/agents/gsd-planner.md for your role and instructions.\n\n" + filled_prompt, subagent_type="general-purpose", model=...)` — used for planner, phase-researcher, project-researcher. This pattern exists so the orchestrator can pass a model override cleanly while still getting the specialized behavior from the agent file's instructions.

### 1.2 `/gsd:execute-phase` (file: `commands/gsd/execute-phase.md`, execution_context pulls in `workflows/execute-phase.md`)

Process (11 numbered steps in the command; the referenced workflow file has the same steps as `<step name=...>` blocks):

1. **Resolve model profile** — reads `.planning/config.json` → `model_profile` (quality/balanced/budget), looks up per-agent model from a table (`gsd-executor`, `gsd-verifier`).
2. **Validate phase exists** — `ls .planning/phases/{PHASE}-*/*-PLAN.md`.
3. **Discover plans** — lists `*-PLAN.md`, checks for matching `*-SUMMARY.md` (= already done), filters by `--gaps-only` flag (`gap_closure: true` frontmatter).
4. **Group by wave** — reads `wave:` field from each plan's YAML frontmatter (pre-computed at plan time by `gsd-planner`, not computed here).
5. **Execute waves** — **this is the parallelization core.** For each wave in ascending order: read plan file contents + `STATE.md` into shell vars (because `@file` includes don't cross `Task()` boundaries), then issue **multiple `Task()` calls in a single message** — one per plan in the wave — each `subagent_type="gsd-executor"`. The Task tool call blocks until _all_ parallel calls in that message return. No polling, no background agents, no `TaskOutput` loops — genuine synchronous fan-out/fan-in per wave, sequential across waves.
6. **Commit orchestrator corrections** — `git status --porcelain`; if dirty, commit as `fix({phase}): orchestrator corrections`.
7. **Verify phase goal** — spawns exactly one `gsd-verifier` (unless `config.workflow.verifier=false`). Verifier writes `{phase}-VERIFICATION.md` with `status: passed | gaps_found | human_needed`.
8. **Update ROADMAP.md, STATE.md.**
9. **Update REQUIREMENTS.md** traceability (Pending → Complete).
10. **Commit phase completion** — single bundled commit `docs({phase}): complete {phase-name} phase`.
11. **Offer next steps** — routes to Route A (next phase), B (milestone complete), or C (gap closure via `/gsd:plan-phase {X} --gaps`).

**Checkpoint handling** (`<checkpoint_handling>` in the command, full detail in the workflow's `checkpoint_handling` step): plans with `autonomous: false` pause mid-execution. The executor subagent returns a structured `## CHECKPOINT REACHED` block instead of completing; the orchestrator presents it to the user in the main thread, collects a response, then spawns a **fresh** `gsd-executor` continuation agent (never resumes the paused one — "Resume relies on Claude Code's internal serialization which breaks with parallel tool calls. Fresh agents with explicit state are more reliable"). The continuation agent's prompt includes a `<completed_tasks>` table with prior commit hashes so it can verify state and skip redone work.

**Deviation rules** (executor-side, defined in `gsd-executor.md` and mirrored in the command's `<deviation_rules>`): Rule 1 auto-fix bugs, Rule 2 auto-add missing critical functionality, Rule 3 auto-fix blockers — all fixed silently and logged in SUMMARY.md, no user involvement. Rule 4 (architectural changes) is the only one that stops execution and returns a checkpoint.

**Commit discipline** (`<commit_rules>`): per-task atomic commits (`{type}({phase}-{plan}): {task-name}`), a separate plan-metadata commit (`docs({phase}-{plan}): complete [plan-name] plan`), and a phase-completion commit. Never `git add .` or `git add -A` — always individual file staging.

### 1.3 `/gsd:plan-phase` (file: `commands/gsd/plan-phase.md`)

Sequential (not parallel) pipeline: **Research → Plan → Verify → (revise loop, max 3 iterations) → Done.**

1. Resolve model profile (`gsd-phase-researcher`, `gsd-planner`, `gsd-plan-checker`).
2. Parse args/flags (`--research`, `--skip-research`, `--gaps`, `--skip-verify`), normalize phase number (`8` → `08`, `2.1` → `02.1`).
3. Validate phase against `ROADMAP.md`.
4. Ensure phase directory exists (`.planning/phases/{PHASE}-{name}/`).
5. **Research stage** (skippable): spawns a single `gsd-phase-researcher` (bootstrapped via `general-purpose`) → writes `{phase}-RESEARCH.md`. Returns `## RESEARCH COMPLETE` or `## RESEARCH BLOCKED`.
6. Check existing plans, offer continue/view/replant.
7. Read context files into shell vars (again, no cross-Task `@` includes).
8. **Spawn `gsd-planner`** (bootstrapped via `general-purpose`) with inlined `STATE.md`, `ROADMAP.md`, `REQUIREMENTS.md`, `CONTEXT.md`, `RESEARCH.md`. Planner writes one or more `{phase}-{NN}-PLAN.md` files directly to disk with frontmatter (`wave`, `depends_on`, `files_modified`, `autonomous`, `must_haves`) and returns `## PLANNING COMPLETE` / `## CHECKPOINT REACHED` / `## PLANNING INCONCLUSIVE`.
9. Handle planner return.
10. **Spawn `gsd-plan-checker`** (direct `subagent_type="gsd-plan-checker"`) — static analysis of the plan files against 6 dimensions (requirement coverage, task completeness, dependency correctness, key-links planned, scope sanity, must_haves derivation). Returns `## VERIFICATION PASSED` or `## ISSUES FOUND` with structured YAML issue list.
11. **Revision loop** — up to 3 iterations: re-spawn `gsd-planner` in "revision mode" with checker issues, then re-spawn `gsd-plan-checker`. After 3 failed iterations, offers force-proceed / provide-guidance / abandon.
12. Present final banner, route to `/gsd:execute-phase {X}`.

Stage banners shown at each transition: `GSD ► RESEARCHING PHASE {X}`, `GSD ► PLANNING PHASE {X}`, `GSD ► VERIFYING PLANS`.

### 1.4 `/gsd:new-project` (file: `commands/gsd/new-project.md`)

The heaviest orchestrator — a linear 10-phase flow with the **only genuinely large parallel fan-out in the whole system**:

1. **Setup** — abort if `.planning/PROJECT.md` exists; `git init` if needed; brownfield detection (scans for `*.ts/js/py/go/rs/swift/java`, `package.json` et al.).
2. **Brownfield offer** — `AskUserQuestion` to run `/gsd:map-codebase` first.
3. **Deep questioning** — freeform "What do you want to build?" then iterative `AskUserQuestion` follow-ups (not a fixed script) referencing `references/questioning.md`. Loops on an `AskUserQuestion` decision gate ("Create PROJECT.md" vs "Keep exploring").
4. **Write `PROJECT.md`**, commit (`docs: initialize project`).
5. **Workflow preferences** — two rounds of `AskUserQuestion` (mode/depth/parallelization/git-tracking, then research/plan_check/verifier/model_profile toggles) → writes `.planning/config.json`, commits (`chore: add project config`).
   5.5. Resolve model profile.
6. **Research decision** — if opted in: `mkdir .planning/research`, then **spawns 4 `gsd-project-researcher` agents in parallel in one message** (`subagent_type="general-purpose"`, bootstrapped with the agent file), one each for STACK, FEATURES, ARCHITECTURE, PITFALLS dimensions — displayed to the user as:
   ```
   ◆ Spawning 4 researchers in parallel...
     → Stack research
     → Features research
     → Architecture research
     → Pitfalls research
   ```
   After all 4 return, spawns a single `gsd-research-synthesizer` (direct `subagent_type`) to read all 4 files and write `.planning/research/SUMMARY.md`, which alone commits everything (the 4 researchers write files but do not commit — an explicit design choice noted in `gsd-project-researcher.md`: "You are always spawned in parallel with other researchers... DO NOT commit").
7. **Define requirements** — presents features by category from research (or gathers conversationally), scopes via `AskUserQuestion` multiSelect per category, writes `.planning/REQUIREMENTS.md` with `REQ-ID` format (`AUTH-01`), commits.
8. **Create roadmap** — spawns a single `gsd-roadmapper` (direct `subagent_type`) which derives phases from requirements (not a template), validates 100% requirement coverage, writes `ROADMAP.md` + `STATE.md` + updates `REQUIREMENTS.md` traceability **immediately** ("write files first, then return... ensures artifacts persist even if context is lost"). Presents to user via `AskUserQuestion` (Approve / Adjust phases / Review full file); adjust triggers a re-spawn of `gsd-roadmapper` with revision context.
9. Commit roadmap.
10. Done — presents artifact table, routes to `/gsd:discuss-phase 1`.

### 1.5 State persistence — `.planning/` is the entire "memory"

No database, no server state. Everything is markdown/YAML/JSON files under `.planning/`:

```
.planning/
  PROJECT.md          # vision, core value, key decisions table
  config.json          # mode, depth, model_profile, workflow.{research,plan_check,verifier}, parallelization, gates
  REQUIREMENTS.md      # REQ-IDs, v1/v2/out-of-scope, traceability table (REQ → Phase → Status)
  ROADMAP.md           # phases with Goal/Depends-on/Requirements/Success-Criteria/Plans checklist + Progress table
  STATE.md             # <100-line "digest": current phase/plan/status, progress bar, velocity metrics, decisions, blockers, session continuity
  research/            # STACK.md, FEATURES.md, ARCHITECTURE.md, PITFALLS.md, SUMMARY.md (new-project only)
  codebase/            # STACK.md, ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, TESTING.md, CONCERNS.md, INTEGRATIONS.md (map-codebase only)
  phases/
    {NN}-{phase-name}/
      {phase}-CONTEXT.md        # from /gsd:discuss-phase
      {phase}-RESEARCH.md       # from gsd-phase-researcher
      {phase}-{NN}-PLAN.md      # from gsd-planner; frontmatter: phase, plan, type, wave, depends_on, files_modified, autonomous, must_haves{truths,artifacts,key_links}
      {phase}-{NN}-SUMMARY.md   # from gsd-executor after execution; frontmatter: subsystem, tags, requires/provides/affects, tech-stack, key-files, metrics
      {phase}-VERIFICATION.md   # from gsd-verifier; frontmatter status: passed|gaps_found|human_needed, gaps: [...]
  debug/
    {slug}.md           # active gsd-debugger sessions (status: gathering|investigating|fixing|verifying|resolved)
    resolved/{slug}.md
```

`STATE.md` is read as the very first step of essentially every orchestrator and every subagent ("load_project_state priority=first") — it's the cheap, always-current snapshot that lets a fresh context window pick up exactly where a previous one left off. `SUMMARY.md` frontmatter forms a **dependency graph** (`requires`/`provides`/`affects`/`subsystem`) that `gsd-planner` scans (first ~25 lines of every summary) to select which 2-4 prior-phase summaries are actually relevant before reading them in full — an explicit context-budget optimization.

Git is the audit trail: nearly every write step ends in a scoped `git add <specific files>` + `git commit -m "type(scope): message"`, individually staged, never `git add -A`. This is controllable via `config.json`'s `commit_docs` (default `true`) — see `references/planning-config.md`.

---

## 2. Agent Inventory

All 11 agents live at `~/.claude/agents/gsd-*.md`. Frontmatter schema (identical shape across all):

```yaml
---
name: gsd-executor
description: <one-line, states role + who spawns it>
tools: Read, Write, Edit, Bash, Grep, Glob # exact allow-list, varies per agent
color: yellow # UI-only, used consistently per role
---
```

| Agent                      | `color` | Tools                                                                | Spawned by                                                                   | Role                                                                                                                                                                                                             | Writes                                                                                                              |
| -------------------------- | ------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `gsd-executor`             | yellow  | Read, Write, Edit, Bash, Grep, Glob                                  | `execute-phase` orchestrator (per plan, per wave)                            | Executes one PLAN.md atomically: per-task commits, deviation rules 1-4, checkpoint pause/return, TDD red-green-refactor when `tdd="true"`                                                                        | `{phase}-{plan}-SUMMARY.md`, updates `STATE.md`                                                                     |
| `gsd-planner`              | green   | Read, Write, Bash, Glob, Grep, WebFetch, mcp__context7__*            | `plan-phase` orchestrator                                                    | Decomposes a phase into 2-3-task PLAN.md files, builds dependency graph, assigns wave numbers, derives `must_haves` goal-backward; also handles gap-closure mode (`--gaps`) and revision mode (checker feedback) | `{phase}-{NN}-PLAN.md` (multiple), updates `ROADMAP.md`                                                             |
| `gsd-plan-checker`         | green   | Read, Bash, Glob, Grep                                               | `plan-phase` orchestrator (after planner)                                    | Static goal-backward verification of PLANS (not code) across 6 dimensions before execution burns context                                                                                                         | `## VERIFICATION PASSED` or `## ISSUES FOUND` (no file writes — returns to orchestrator)                            |
| `gsd-verifier`             | green   | Read, Bash, Grep, Glob                                               | `execute-phase` orchestrator (after all waves)                               | Goal-backward verification of the _codebase_ after execution: 3-level artifact check (exists/substantive/wired), key-link wiring checks, stub-pattern detection, does NOT trust SUMMARY.md claims                | `{phase}-VERIFICATION.md` (does not commit — leaves that to orchestrator)                                           |
| `gsd-phase-researcher`     | cyan    | Read, Write, Bash, Grep, Glob, WebSearch, WebFetch, mcp__context7__* | `plan-phase` orchestrator (integrated) or `research-phase` (standalone)      | Researches implementation approach for ONE phase; Context7 → official docs → WebSearch confidence hierarchy                                                                                                      | `{phase}-RESEARCH.md`                                                                                               |
| `gsd-project-researcher`   | cyan    | Read, Write, Bash, Grep, Glob, WebSearch, WebFetch, mcp__context7__* | `new-project` / `new-milestone` (4x parallel)                                | Ecosystem/feasibility/comparison research at project scope, one dimension each (stack/features/architecture/pitfalls)                                                                                            | `.planning/research/{STACK,FEATURES,ARCHITECTURE,PITFALLS}.md` — explicitly does NOT commit                         |
| `gsd-research-synthesizer` | purple  | Read, Write, Bash                                                    | `new-project` (after the 4 researchers complete)                             | Reads all 4 research files, synthesizes SUMMARY.md with roadmap implications, is the one that commits ALL research files together                                                                                | `.planning/research/SUMMARY.md`, `git commit` for the whole research/ dir                                           |
| `gsd-roadmapper`           | purple  | Read, Write, Bash, Glob, Grep                                        | `new-project` orchestrator                                                   | Derives phases from requirements (not template-imposed), validates 100% requirement coverage, goal-backward success criteria per phase                                                                           | `.planning/ROADMAP.md`, `.planning/STATE.md`, updates `REQUIREMENTS.md` traceability                                |
| `gsd-codebase-mapper`      | cyan    | Read, Bash, Grep, Glob, Write                                        | `/gsd:map-codebase` (per focus area: tech/arch/quality/concerns)             | Explores existing codebase, writes structured docs directly (reduces orchestrator context)                                                                                                                       | `.planning/codebase/{STACK,INTEGRATIONS,ARCHITECTURE,STRUCTURE,CONVENTIONS,TESTING,CONCERNS}.md` depending on focus |
| `gsd-debugger`             | orange  | Read, Write, Edit, Bash, Grep, Glob, WebSearch                       | `/gsd:debug` command, or `diagnose-issues` workflow (parallel UAT diagnosis) | Scientific-method bug investigation with persistent, resumable debug-file state; hypothesis testing, checkpoint on unavoidable user actions                                                                      | `.planning/debug/{slug}.md`, moved to `resolved/` on completion; may Edit source files to apply fix                 |
| `gsd-integration-checker`  | blue    | Read, Bash, Grep, Glob                                               | milestone auditor (`/gsd:audit-milestone`)                                   | Cross-phase wiring/E2E-flow verification: export→import maps, API→consumer checks, form→handler chains — distinct from `gsd-verifier` which checks a single phase                                                | Returns structured report only, no file writes described                                                            |

**Model resolution** (`references/model-profiles.md`) is a separate, cross-cutting concern: every orchestrator reads `config.json.model_profile` (`quality|balanced|budget`, default `balanced`) and looks up a per-agent Claude model from a fixed table before spawning (e.g. `gsd-planner`: opus/opus/sonnet; `gsd-executor`: opus/sonnet/sonnet; `gsd-codebase-mapper`: sonnet/haiku/haiku). This means the model actually running any given subagent varies by project config — a watcher can't assume a fixed model per agent type.

---

## 3. Observable Signals for an External Transcript Watcher

### 3.1 `subagent_type` strings that will appear in Task tool calls

Exact strings, verified from the command/workflow files:

```
gsd-executor
gsd-planner            (usually wrapped as subagent_type="general-purpose" with a
gsd-phase-researcher     "First, read <HOME>/.claude/agents/gsd-XXX.md..." prompt prefix)
gsd-project-researcher   ^ same bootstrapped pattern
gsd-plan-checker        (spawned directly with subagent_type="gsd-plan-checker")
gsd-verifier            (spawned directly with subagent_type="gsd-verifier")
gsd-roadmapper          (spawned directly with subagent_type="gsd-roadmapper")
gsd-research-synthesizer (spawned directly)
gsd-codebase-mapper     (spawned directly, per focus area: tech/arch/quality/concerns)
gsd-debugger            (spawned directly or via diagnose-issues workflow)
gsd-integration-checker (spawned directly, by audit-milestone)
```

**Important nuance for a watcher**: `gsd-planner`, `gsd-phase-researcher`, and `gsd-project-researcher` are frequently invoked with `subagent_type="general-purpose"` — the actual GSD role is only detectable from the prompt text (`"First, read <HOME>/.claude/agents/gsd-planner.md for your role and instructions.\n\n..."`) not from the `subagent_type` field alone. A watcher relying purely on `subagent_type` will misclassify these as generic agents unless it also greps the prompt for `agents/gsd-*.md`.

### 3.2 Distinctive banner/marker text (verbatim, from `references/ui-brand.md`)

Stage banners — always this exact box shape, 55 `━` characters, always prefixed `GSD ►`:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► {STAGE NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Observed stage names: `QUESTIONING`, `RESEARCHING`, `RESEARCHING PHASE {X}`, `DEFINING REQUIREMENTS`, `CREATING ROADMAP`, `PLANNING PHASE {N}`, `VERIFYING PLANS`, `EXECUTING WAVE {N}`, `VERIFYING`, `PHASE {N} COMPLETE ✓`, `MILESTONE COMPLETE 🎉`, `PHASE {X} GAPS FOUND ⚠`, `PHASE {X} PLANNED ✓`, `PROJECT INITIALIZED ✓`.

Spawning indicators (single-agent and fan-out):

```
◆ Spawning researcher...
◆ Spawning 4 researchers in parallel...
  → Stack research
  → Features research
  → Architecture research
  → Pitfalls research
✓ Researcher complete: STACK.md written
◆ Spawning planner...
◆ Spawning plan checker...
◆ Spawning roadmapper...
```

Checkpoint boxes (62-char double-line box, from `references/ui-brand.md` and `checkpoints.md`):

```
╔══════════════════════════════════════════════════════════════╗
║  CHECKPOINT: Verification Required                          ║
╚══════════════════════════════════════════════════════════════╝
...
──────────────────────────────────────────────────────────────
→ YOUR ACTION: Type "approved" or describe issues
──────────────────────────────────────────────────────────────
```

Variants: `CHECKPOINT: Decision Required` (→ `Select: option-a / option-b`), `CHECKPOINT: Action Required` (→ `Type "done" when complete`).

Structured subagent return headers (these are the reliable machine-parseable markers — always level-2 markdown headers, always exactly this text):

```
## PLANNING COMPLETE
## CHECKPOINT REACHED
## PLANNING INCONCLUSIVE
## REVISION COMPLETE
## GAP CLOSURE PLANS CREATED
## RESEARCH COMPLETE
## RESEARCH BLOCKED
## VERIFICATION PASSED
## ISSUES FOUND
## Verification Complete          (gsd-verifier's own completion notice, distinct from plan-checker's PASSED/ISSUES)
## ROADMAP CREATED
## ROADMAP REVISED
## ROADMAP BLOCKED
## SYNTHESIS COMPLETE
## SYNTHESIS BLOCKED
## PLAN COMPLETE                  (executor)
## Mapping Complete               (codebase-mapper)
## ROOT CAUSE FOUND               (debugger, find_root_cause_only mode)
## DEBUG COMPLETE                 (debugger, find_and_fix mode)
## INVESTIGATION INCONCLUSIVE     (debugger)
## Integration Check Complete     (integration-checker)
```

Status symbols used consistently: `✓` complete/passed, `✗` failed/missing, `◆` in-progress, `○` pending, `⚡` auto-approved, `⚠` warning, `🎉` milestone (banner only).

Next-Up block (appears after nearly every command completion — `references/continuation-format.md`):

```
───────────────────────────────────────────────────────────────

## ▶ Next Up

**{identifier}: {name}** — {one-line description}

`{command}`

<sub>`/clear` first → fresh context window</sub>

───────────────────────────────────────────────────────────────

**Also available:**
- `{alt command}` — description
```

### 3.3 Tool-call sequence fingerprints per phase

- **Research phase**: `Bash(cat .planning/config.json...)` → `Task(subagent_type=general-purpose, prompt contains "gsd-phase-researcher.md")` → agent internally does `mcp__context7__resolve-library-id` → `mcp__context7__query-docs` → `WebFetch` → `WebSearch` → `Write({phase}-RESEARCH.md)` → `Bash(git add/commit)`.
- **Planning phase**: `Task(...gsd-planner.md...)` → agent does `Read` (STATE/ROADMAP/SUMMARY frontmatter scan) → `Write` (multiple `*-PLAN.md`) → `Bash(git commit)` → orchestrator `Task(subagent_type=gsd-plan-checker)` → agent `Read` + `Bash(grep...)` only, no writes, returns text.
- **Execution wave** (the clearest parallelism fingerprint): a single assistant turn containing **N consecutive `Task(subagent_type=gsd-executor, ...)` calls with no other tool calls between them** — this is the strongest signal for "wave" detection. Each executor internally does `Bash(git status --short)` → `Bash(git add <file>)` (repeated per task) → `Bash(git commit -m "type(phase-plan): task")` (repeated per task) → `Write({phase}-{plan}-SUMMARY.md)` → `Edit(STATE.md)` → final `Bash(git commit -m "docs(...): complete plan")`.
- **Verification**: single `Task(subagent_type=gsd-verifier)` → agent does many `Bash(grep -E "TODO|FIXME|...")` / `Bash(wc -l ...)` stub-detection calls → `Write({phase}-VERIFICATION.md)` → returns text (no commit — orchestrator commits).
- **New-project research burst**: exactly 4 `Task(subagent_type=general-purpose, prompt contains "gsd-project-researcher.md")` calls in one message, distinguishable from execute-phase waves by the prompt content mentioning `STACK.md`/`FEATURES.md`/`ARCHITECTURE.md`/`PITFALLS.md`, followed later by a single `Task(subagent_type=gsd-research-synthesizer)`.

### 3.4 What "parallel waves" look like concretely

A watcher tailing the transcript JSON should look for **N `tool_use` blocks of type `Task` inside a single assistant `message`** (same `message.id`), each with a distinct plan path in the prompt but identical `subagent_type`. The orchestrator's own text immediately before it, per `workflows/execute-phase.md`, is a fixed template:

```
---

## Wave {N}

**{Plan ID}: {Plan Name}**
{2-3 sentences}

Spawning {count} agent(s)...

---
```

followed later (after the blocking Task results all return) by:

```
---

## Wave {N} Complete

**{Plan ID}: {Plan Name}**
{what was built}

---
```

Since Claude Code's Task tool blocks synchronously until every parallel call in the batch resolves, a watcher will see all N executor sub-transcripts start at effectively the same timestamp and the orchestrator's next message only appears after the slowest one finishes — genuine fork/join, not fire-and-forget.

---

## 4. Statusline + Update Hooks

### 4.1 `~/.claude/hooks/gsd-check-update.js`

Runs once per session (invoked as a `SessionStart` hook). Spawns a **detached background child process** (`spawn(..., {stdio:'ignore'}); child.unref()`) that:

- Reads installed GSD version from `./.claude/get-shit-done/VERSION` (project-local, checked first) or `~/.claude/get-shit-done/VERSION` (global fallback).
- Shells out to `npm view get-shit-done-cc version` (10s timeout) to get the latest published version.
- Writes `{ update_available: bool, installed, latest, checked: <unix ts> }` to `~/.claude/cache/gsd-update-check.json`.

Purely read-only against `.claude/`; only network call is the `npm view` registry lookup. No GSD workflow state is touched.

### 4.2 `~/.claude/hooks/gsd-statusline.js`

A Claude Code `statusLine` script. Reads the harness-provided JSON on stdin (`model`, `workspace.current_dir`, `session_id`, `context_window.remaining_percentage`) and composes one line:

- **GSD update flag**: reads the cache file written by the check-update hook; if `update_available`, prepends `⬆ /gsd:update │` in yellow.
- **Model name** (dim) `│` **current task** (bold, from the _in-progress_ Claude Code native TodoWrite item, not a GSD-specific file — read from `~/.claude/todos/{session_id}*-agent-*.json`, most-recently-modified) `│` **directory basename** (dim) + a 10-segment context-usage progress bar colored green→yellow→orange→red/blinking-skull past 80%.

Neither hook talks to `.planning/`; the statusline's "current task" comes from Claude Code's own todo list mechanism, which GSD orchestrators populate via the standard `TodoWrite` tool (declared in `execute-phase.md`'s `allowed-tools`) — so an external watcher can correlate GSD phase/plan progress with statusline task text, but the hook itself has no GSD-specific parsing beyond the update-banner and the VERSION file reads.

---

## 5. Mapping to the Abstract Event Vocabulary

| Abstract event       | GSD equivalent / trigger                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow_started`   | A `/gsd:*` slash command invocation begins (e.g., `/gsd:execute-phase 3`). Marked by the orchestrator's first stage banner (`GSD ► ...`) or, for execute-phase, by the `## Execution Plan` wave table.                                                                                                                                                                                          |
| `agent_created`      | A `Task(...)` tool_use block appears in the orchestrator's message — this is simultaneously "created" and "started" since Claude Code's Task tool has no separate provisioning step.                                                                                                                                                                                                            |
| `agent_started`      | Same moment as `agent_created` (no async spawn-then-start gap in this architecture — Task calls block).                                                                                                                                                                                                                                                                                         |
| `agent_output`       | Any intermediate tool result inside a subagent's own transcript (its Reads/Writes/Bashes), and finally its structured return block (`## PLAN COMPLETE`, `## RESEARCH COMPLETE`, etc.) which is the payload delivered back to the orchestrator.                                                                                                                                                  |
| `agent_tool_called`  | Each Read/Write/Edit/Bash/Grep/Glob/WebFetch/WebSearch/mcp__context7__* call made _inside_ a subagent's own execution (per the tool allow-list in that agent's frontmatter).                                                                                                                                                                                                                    |
| `agent_completed`    | The `Task()` call returns in the orchestrator's thread with one of the structured headers (`## PLAN COMPLETE`, `## VERIFICATION PASSED`, `## ROADMAP CREATED`, `## Mapping Complete`, `## DEBUG COMPLETE`, etc.). For `execute-phase` waves specifically, "Wave {N} Complete" banner marks all-agents-in-wave completion.                                                                       |
| `agent_failed`       | `## PLANNING INCONCLUSIVE`, `## ROADMAP BLOCKED`, `## RESEARCH BLOCKED`, `## SYNTHESIS BLOCKED`, `## INVESTIGATION INCONCLUSIVE`, or — for executors — a missing `SUMMARY.md` at the expected path after a wave (detected by the orchestrator, not self-reported) plus the "Handle failures" branch in `workflows/execute-phase.md` ("Report which plan failed... Ask user: Continue or Stop"). |
| `dependency_created` | A plan's `depends_on: []` frontmatter field being set by `gsd-planner` during `assign_waves`, or a `requires:`/`provides:`/`affects:` triple in a SUMMARY.md's frontmatter — this is GSD's literal dependency graph, consumed later by `gsd-planner`'s `read_project_history` step for context-selection. Also the `wave` number itself is effectively "N depends on wave N-1."                 |
| `approval_requested` | Any `AskUserQuestion` call from an orchestrator (roadmap approval, workflow-preference rounds, requirements scoping), or a `## CHECKPOINT REACHED` return from an executor/planner/debugger requiring the checkpoint box UI and a literal "Type approved / Select option-X" prompt.                                                                                                             |

### Typical `/gsd:execute-phase 3` timeline (narrative)

1. **`workflow_started`** — user runs `/gsd:execute-phase 3`. Orchestrator resolves model profile from `.planning/config.json`, validates `.planning/phases/03-*/` has PLAN.md files.
2. Orchestrator discovers 4 plans (`03-01` … `03-04`), reads `wave:` frontmatter, groups: Wave 1 = [03-01, 03-02] (no deps), Wave 2 = [03-03] (depends on 03-01), Wave 3 = [03-04, checkpoint]. Prints the `## Execution Plan` wave table — this is effectively a batch of **`dependency_created`** signals surfaced to the user.
3. **Wave 1**: orchestrator prints the "## Wave 1" description block, then issues **two `Task()` calls in one message** (`subagent_type="gsd-executor"`, model resolved e.g. `sonnet`) — `agent_created`/`agent_started` ×2, running truly concurrently. Each executor internally reads STATE.md, executes its 2-3 tasks with per-task `Bash git commit` (`agent_tool_called` many times each), writes its own `SUMMARY.md`, and returns `## PLAN COMPLETE` (`agent_completed` ×2). Task tool blocks until both finish; orchestrator prints "## Wave 1 Complete."
4. **Wave 2**: single `Task()` for `03-03` (depends on wave-1 output — a realized `dependency_created` edge). Completes normally, `agent_completed`.
5. **Wave 3**: `Task()` for `03-04`, which has `autonomous: false`. The executor runs its `auto` tasks, then hits a `checkpoint:human-verify` task and **stops**, returning `## CHECKPOINT REACHED` with a Completed-Tasks table and commit hashes instead of `## PLAN COMPLETE` — this is `agent_completed` with a checkpoint payload, not `agent_failed`. Orchestrator renders the 62-char `╔ CHECKPOINT: Verification Required ╗` box (**`approval_requested`**) and blocks on user text. User replies "approved." Orchestrator spawns a **fresh** `gsd-executor` continuation agent (`agent_created` again, new instance, not a resume) carrying the completed-tasks table forward; it finishes the remaining tasks and returns `## PLAN COMPLETE`.
6. Orchestrator checks `git status --porcelain` for stray corrections, commits if needed.
7. Orchestrator spawns **one** `gsd-verifier` (`agent_created`/`started`). It does NOT trust the SUMMARYs — greps the actual codebase for stub patterns, checks 3-level artifact status (exists/substantive/wired), writes `03-VERIFICATION.md` with `status: passed`, returns `## Verification Complete` (`agent_completed`).
8. Orchestrator updates `ROADMAP.md`, `STATE.md`, `REQUIREMENTS.md`, bundles one final `docs(03): complete phase execution` commit, and prints the `GSD ► PHASE 3 COMPLETE ✓` banner plus a `## ▶ Next Up` block pointing at `/gsd:discuss-phase 4` — **`workflow_started`** boundary for the next command, closing this one.

If step 7's verifier instead returned `gaps_found`, the timeline would end with a `GSD ► PHASE 3 GAPS FOUND ⚠` banner and a routed suggestion of `/gsd:plan-phase 3 --gaps`, which restarts a `gsd-planner`(gap-closure mode)→`gsd-executor`(new plans, `gap_closure: true`)→`gsd-verifier` sub-loop scoped only to the failed truths.

---

### Files referenced (all read-only, none modified)

`<HOME>/.claude/commands/gsd/{execute-phase,plan-phase,new-project}.md`, `<HOME>/.claude/agents/gsd-{executor,planner,plan-checker,verifier,phase-researcher,project-researcher,research-synthesizer,roadmapper,codebase-mapper,debugger,integration-checker}.md`, `<HOME>/.claude/get-shit-done/workflows/execute-phase.md`, `<HOME>/.claude/get-shit-done/references/{ui-brand,model-profiles,checkpoints,continuation-format,planning-config}.md`, `<HOME>/.claude/get-shit-done/templates/{state,summary,roadmap,config.json}.md`, `<HOME>/.claude/get-shit-done/VERSION`, `<HOME>/.claude/hooks/{gsd-check-update.js,gsd-statusline.js}`.
