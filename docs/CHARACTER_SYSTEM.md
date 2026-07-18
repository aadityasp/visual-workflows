# Character & Animation System (v1)

Original characters — no resemblance to Codex/OpenAI, Anthropic, or any
existing mascot. Design goal: a tiny coworker you can read at 44px.

## The default pack: "Crew"

One base rig, four role variants (differentiated by silhouette accessory and
accent tint, so roles read even in grayscale):

- **Scout** (planner/research): antenna + notepad silhouette
- **Wrench** (coder/executor): visor + keyboard silhouette
- **Beaker** (tester): goggle strap + flask silhouette
- **Lens** (reviewer): monocle ring + magnifier silhouette

Rig: rounded-square body with soft squash-and-stretch, two expressive eyes
(the main emotion channel), stub arms for pose states, floating shadow.
Pure SVG, 5 layers: `shadow`, `body`, `face`, `accessory`, `fx` (particles).

## State → animation mapping

| State             | Eyes                      | Body                         | FX layer                             |
| ----------------- | ------------------------- | ---------------------------- | ------------------------------------ |
| idle              | slow blink                | 3s breathe loop              | —                                    |
| waiting           | look up-left periodically | breathe                      | zZ every 8s (subtle)                 |
| thinking          | half-closed, drift        | tilt 2°                      | 3 orbiting dots                      |
| reading           | left-right scan           | leans in                     | scanline over a page glyph           |
| searching         | wide, darting             | slight bounce                | sweeping lens beam                   |
| writing_code      | focused down              | micro-bounce per "keystroke" | rising code ticks `{;}`              |
| running_command   | steady                    | vibration 1px                | pulse rings                          |
| testing           | one eye squint            | still                        | bubbles from flask                   |
| reviewing         | monocle glint             | slow nod                     | arc sweep                            |
| blocked           | flat/unamused             | arms crossed pose            | amber ! bubble                       |
| awaiting_approval | pleading (big)            | hand raised pose             | ✋ bubble                            |
| failed            | x_x then recovering       | slumped 4°                   | single smoke puff (one-shot)         |
| completed         | happy arcs ^^             | hop once (one-shot)          | confetti burst ≤600ms, ≤12 particles |
| cancelled         | closed                    | powers down (dim)            | —                                    |

Rules: ambient loops ≤ 3 properties animated, transform/opacity only, ≥3s
period, ≤2° rotation — motion must read as life, not noise. One-shots
(completed/failed) run once then rest. `prefers-reduced-motion`: all loops
freeze to a characteristic static pose per state (pose alone must be readable).

## Implementation

- Each variant is one inline SVG component; states applied as
  `data-state="thinking"` on the root; all animation is CSS keyframes scoped
  to `[data-state]` selectors. No JS animation loop, no rAF per character —
  the browser compositor does the work. Total CSS+SVG budget ≤ 30KB for the
  whole pack.
- One-shot animations triggered by state-change class with
  `animationend` cleanup.
- Characters are decorative: `aria-hidden="true"`; the status chip carries
  the accessible name.

## Character pack API (contributor extension point)

A pack is a directory (or npm package) with a manifest:

```json
{
  "name": "crew",
  "version": "1.0.0",
  "license": "MIT",
  "author": "…",
  "variants": {
    "scout": { "module": "./scout.js" },
    "wrench": { "module": "./wrench.js" }
  },
  "variantMapping": {
    "byAgentType": { "*plan*": "scout", "*review*": "lens", "*test*": "beaker" },
    "default": "wrench"
  }
}
```

Each variant module default-exports a component `({ state, size, accent }) =>`
element implementing the 14-state contract (missing states fall back to
`idle`). v1 loads packs bundled at build time via the registry in
`apps/ui/src/characters/` (`CHARACTER_VARIANTS` in `states.ts` +
`VariantDefinition`s in `variants.tsx`); runtime/npm pack loading is roadmap
(needs a sandboxing story before executing third-party modules — documented in
SECURITY.md).
Lottie-based packs: a `LottieVariant` helper is specced (accepts a
state→animation JSON map) but not shipped in v1 to keep the bundle light.
