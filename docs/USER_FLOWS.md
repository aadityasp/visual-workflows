# User Flows (v1)

## 1. First run (no Claude Code needed)

`npm start` (or `npm run dev` from a clone) → bridge starts, browser
opens `http://127.0.0.1:4777` → empty state offers two big actions:
**▶ Run the demo** · **⚡ Connect Claude Code**. No signup, no config.

## 2. Demo

Click ▶ → "DEMO" badge appears in TopBar → scripted 7-agent scenario plays
(planner → researcher → 2 parallel coders → tester → reviewer finds issue →
coder fixes → tester re-runs green → main presents). Panels appear/connect/
collapse live. Replayable and scrubbable afterwards. Total ~90s, skippable
to end.

## 3. Connect Claude Code

"Connect" panel shows one copy-paste command: `npm run vw -- connect`.
The CLI: detects `~/.claude`, prints the exact hooks it will add to
`settings.json` (diff view), asks y/N, backs up settings, writes, prints
"open a new Claude Code session". Alternative shown alongside: install as
plugin → `/visual-workflows` slash command becomes available in-session.
Uninstall: `npm run vw -- disconnect` (restores from backup/removes
only our entries).

## 4. Live monitoring (the core loop)

User starts a workflow in Claude Code (e.g. `/gsd:execute-phase`). Dashboard:
session appears in picker → main agent panel → subagent panels bloom and
connect as Task calls are observed → parallel wave = column of panels →
operator glances at StatusBar counts; works elsewhere; Attention Rail slides
in only for approval/blocker/failure → click rail card → camera flies to the
troubled agent → read error/approval context → handle it in Claude Code →
rail clears. Run completes → workflow banner shows summary; panels collapsed
to chips; "save recording?" toast if recording is off (one click enables for
next time; never retroactive).

## 5. Replay

Session picker → Recordings tab → pick file → same canvas in Replay mode with
transport bar → play at 4×, scrub to the failure, focus the failing agent,
read its terminal at that seq point. Share = the `.jsonl` file itself
(redacted at capture; user is still warned before sharing).

## 6. Focus / keyboard-first review

`Tab` to cycle panels → `Enter` focus → full terminal + Files/Tools tabs →
`Esc` out → `o` refit overview. No mouse required for any core action.

## 7. Contributor adds a character pack

Fork → `apps/ui/src/characters/` → copy a built-in Crew variant as a skeleton,
implement the 14-state contract → register it (`CHARACTER_VARIANTS` in
`states.ts`, a `VariantDefinition` in `variants.tsx`) → `npm test` runs the pack
contract test in `characters.test.tsx` (every variant × state renders, no
console errors, respects reduced-motion) → PR with a GIF. CONTRIBUTING.md
documents this as the "good first PR" path.
