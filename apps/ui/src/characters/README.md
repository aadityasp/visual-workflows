# Character pack contract (the "Crew" rig)

This directory is the runtime for agent characters — the small animated figures in
each AgentPanel. A character says, at a glance and without colour, what an agent is
doing. This file is the contributor contract referenced from
[CONTRIBUTING.md](../../../../CONTRIBUTING.md); read it alongside
[docs/CHARACTER_SYSTEM.md](../../../../docs/CHARACTER_SYSTEM.md) (the state table and
motion rules) before building a pack.

## Public API

```tsx
import { AgentCharacter, variantForAgent, stateFromAgent } from './index';

<AgentCharacter
  lifecycle={agent.lifecycle} // protocol AgentLifecycle
  activity={agent.activity} // protocol AgentActivity
  variant={variantForAgent(agent.name, agent.agentType)} // optional; defaults 'wrench'
  size={44} // px, optional
  accent="#5b8dd9" // optional; overrides the variant's body tint
/>;
```

- `AgentCharacter` is the only component consumers render. It is pure and
  decorative: the root is `aria-hidden` and carries **no** accessible name — the
  panel's status chip is the accessible label. Never rely on the character alone to
  convey state.
- `variantForAgent(name?, agentType?)` picks a Crew variant from role keywords
  (`plan/research → scout`, `test/qa → beaker`, `review/audit → lens`, else
  `wrench`). Consumers may also pass an explicit `variant`.
- `stateFromAgent(lifecycle, activity)` collapses the protocol pair to one of the
  14 character states. `CHARACTER_STATES` and `CHARACTER_VARIANTS` are exported for
  exhaustiveness checks and tests.

## The 14-state contract

Every pack must render all of `CHARACTER_STATES` (see `states.ts`):

```
idle · waiting · thinking · reading · searching · writing_code ·
running_command · testing · reviewing · blocked · awaiting_approval ·
failed · completed · cancelled
```

Missing states should fall back to `idle` rather than throw. Lifecycle overrides
activity: `failed`/`completed`/`cancelled`/`blocked` and the two `awaiting_*`
lifecycles map to their own poses regardless of activity; `running` shows the live
activity; `created` idles until the agent starts.

## Rig structure

`rig.tsx` is the shared body every Crew variant reuses — a soft rounded-square with
five SVG layers, back to front:

1. `vwc-shadow` — floating ground shadow.
2. `vwc-fx-back` — effects behind the body (rings, pulses, sweep beams).
3. `vwc-puppet` — body, face (eyes/lids/mouth variants), and two arms, all posed via
   CSS transforms.
4. `vwc-acc` — the **variant accessory** (antenna, visor, goggles+flask, monocle).
   This is the silhouette differentiator: roles must read in grayscale, so each
   accessory changes the outline.
5. `vwc-fx-front` — effects in front (thought orbits, read scanline, code ticks,
   test bubbles, alert/hand bubbles, smoke, confetti).

All motion lives in `characters.css`, keyed off `data-state` (and `data-variant`) on
the root `span`. `rig.tsx` is pure structure plus the one-shot lifecycle hook.

## Motion rules

- **CSS only**, `transform`/`opacity` only (GPU-composited). No JS animation, no
  layout thrash.
- **Ambient loops** (thinking, reading, …) run continuously while in that state.
- **One-shot states** (`completed`, `failed`) play an entry animation once, then
  rest. The rig applies `vw-char-once`; when the final fx animation named in
  `ONE_SHOT_FINAL_ANIMATION` ends, it removes the class. If you add a one-shot,
  register its terminal animation name there.
- **Reduced motion**: the app stills every animation globally by setting
  `data-reduced-motion="true"` on `<html>` (see `styles/app.css`). Each state must
  still be legible as a static pose — never encode meaning in motion alone.

## Adding a variant

1. Add its name to `CHARACTER_VARIANTS` in `states.ts`.
2. Register a `VariantDefinition` in `variants.tsx` (a default `tint` plus an
   `Accessory` rendered into the `vwc-acc` group, drawn in the 64×64 SVG space).
3. Give it a distinct **silhouette** so it reads in grayscale.
4. Extend `variantForAgent` in `index.tsx` if a role keyword should map to it.

## Adding a whole pack

Copy a Crew variant in this directory as a skeleton, keep the whole
pack under ~30 KB of SVG+CSS, implement all 14 states, and keep characters original
(no resemblance to existing mascots) and MIT-licensable. The pack contract test in
`characters.test.tsx` renders every variant × every state and asserts the API shape —
run it against your pack.
