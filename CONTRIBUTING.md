# Contributing to visual-workflows

Thanks for helping build the mission control for AI agent workflows. This guide covers setup,
layout, conventions, and the easiest path to a first merged PR.

## Dev setup

The only prerequisite is **Node 22** (>= 22.12.0, npm 10 comes with it).

```bash
git clone https://github.com/aadityasp/visual-workflows.git
cd visual-workflows
npm install
npm run dev     # starts bridge + UI together (concurrently)
```

Open the printed URL and click **Run the demo** to exercise the whole pipeline without Claude Code.

## Repository layout

npm-workspaces monorepo. Full map with rationale: [docs/COMPONENT_MAP.md](docs/COMPONENT_MAP.md).

| Path                     | Package                          | What lives there                                                                                                                                                                                     |
| ------------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`      | `@visual-workflows/protocol`     | THE contract: event types, zod schemas, pure reducer, activity inference, redaction. Depends on nothing internal.                                                                                    |
| `packages/bridge`        | `@visual-workflows/bridge`       | Local server: HTTP `/ingest`, WebSocket `/ws`, event bus + sequencing, auth token, recorder/replay, adapters (demo, hooks receiver, transcript tailer), CLI (`start`/`connect`/`disconnect`/`wipe`). |
| `packages/hook-adapter`  | `@visual-workflows/hook-adapter` | Tiny Claude Code hook forwarder: stdin JSON, redact, POST localhost, always exit 0. Must stay tiny.                                                                                                  |
| `apps/ui`                | `@visual-workflows/ui`           | Vite + React canvas: React Flow graph, agent panels, characters, terminals, stores, replay transport.                                                                                                |
| `apps/ui/src/characters` |                                  | The built-in Crew character pack (Scout/Wrench/Beaker/Lens) and the pack contract — the "good first PR" target ([README](apps/ui/src/characters/README.md)).                                         |
| `plugin/`                |                                  | Claude Code plugin: `/visual-workflows` command + hook entries.                                                                                                                                      |
| `examples/recordings/`   |                                  | Sample JSONL recordings for replay ([format](examples/recordings/README.md)).                                                                                                                        |
| `docs/`                  |                                  | Specs: PRD, architecture, event protocol, UI spec, character system, security, adapters, roadmap, ADRs.                                                                                              |
| `e2e/`                   |                                  | Playwright end-to-end tests (demo run, replay, a11y smoke).                                                                                                                                          |

Dependency rules (enforced by convention and review):

- `protocol` imports nothing internal; everyone imports `protocol`.
- `ui` never imports from `bridge` (they talk only via the WebSocket protocol).
- `hook-adapter` depends only on `protocol`'s redaction; no runtime deps, it runs on every hook fire.
- Adapters implement one interface; deleting an adapter must break nothing else.

## Scripts

Run from the repo root:

| Command                           | What it does                                                  |
| --------------------------------- | ------------------------------------------------------------- |
| `npm run dev`                     | Bridge + UI in watch mode                                     |
| `npm run build`                   | Build all workspaces                                          |
| `npm run typecheck`               | `tsc --noEmit` across workspaces                              |
| `npm run lint`                    | ESLint (flat config, typed rules)                             |
| `npm run format` / `format:check` | Prettier (100 cols, single quotes)                            |
| `npm run test`                    | Unit tests (vitest) across workspaces                         |
| `npm run test:e2e`                | Playwright e2e (`npx playwright install chromium` once first) |
| `npm run check:ts-version`        | Asserts TypeScript stays on 6.x (see below)                   |

Scope any script to one workspace with `-w`, e.g.:

```bash
npm run test -w @visual-workflows/protocol
npm run typecheck -w @visual-workflows/ui
```

Please run `npm run lint && npm run typecheck && npm run test && npm run format:check` before
pushing. CI runs these, plus a TypeScript-version guard (`check:ts-version`), a production
`build`, an external-origin scan of the built UI bundle, `npm audit`, and a Playwright e2e pass
(non-blocking while it stabilizes).

## Good first PR: a character pack

The most fun contribution and the most self-contained. A pack is a set of SVG+CSS character
variants implementing the 14-state contract (`idle` through `completed`); missing states fall back
to `idle`, animation is CSS-only (transform/opacity), and `prefers-reduced-motion` gets a static
pose per state.

1. Read [docs/CHARACTER_SYSTEM.md](docs/CHARACTER_SYSTEM.md) (the state contract and motion rules).
2. Read the rig runtime notes and pack contract in
   [`apps/ui/src/characters/README.md`](apps/ui/src/characters/README.md); the built-in Crew
   variants alongside it are the reference implementation.
3. Copy a Crew variant as a starting skeleton, keep the whole pack under ~30KB of SVG+CSS.
4. Characters must be original work (no resemblance to existing mascots) and MIT-licensable.

v1 packs are compiled in via the pack registry; runtime pack loading is roadmap (needs sandboxing).

## Commit convention

Conventional commits, with the workspace as scope:

```
feat(ui): add minimap toggle shortcut
fix(bridge): resume from correct seq after reconnect
docs(readme): correct quick start port
chore(ci): bump playwright cache key
```

Types: `feat`, `fix`, `docs`, `chore` (also fine: `test`, `refactor`, `perf`).
Scopes: `protocol`, `bridge`, `hook-adapter`, `ui`, `characters`, `plugin`, `ci`, `docs`, `e2e`.

## PR checklist

- [ ] `npm run lint`, `npm run typecheck`, `npm run test` pass locally
- [ ] New behavior has tests (reducer/adapters: unit fixtures; UI: component tests; flows: e2e)
- [ ] No new dependencies (see policy below); lockfile untouched unless that is the point of the PR
- [ ] Protocol changes are additive and documented in [docs/EVENT_PROTOCOL.md](docs/EVENT_PROTOCOL.md)
- [ ] User-visible changes noted in [CHANGELOG.md](CHANGELOG.md) under Unreleased
- [ ] Screenshots or a short capture for UI changes (both themes if styling changed)
- [ ] No secrets, real transcripts, or machine-identifying paths in fixtures or recordings

## Dependency policy

- **Exact pins only** (`save-exact`); no ranges. The lockfile is the source of truth and CI runs
  `npm audit --omit=dev --audit-level=high`.
- **New runtime dependencies need a discussion issue first.** The dep tree is deliberately small;
  every addition is attack surface for a tool that reads terminals and transcripts (no postinstall
  scripts, ever).
- **TypeScript must stay on 6.x.** npm's `typescript@latest` is 7.x (the Go rewrite), but
  typescript-eslint's peer range is `<6.1.0`; "upgrading" silently breaks typed linting.
  `npm run check:ts-version` guards this in CI. Do not bump TS in a drive-by PR.

## Reporting issues

Use the issue forms (bug report asks for your visual-workflows version, OS, and Claude Code
version, since adapter behavior is version-verified). Security issues: do **not** open a public
issue; see [SECURITY.md](SECURITY.md).

## Code of conduct

Be excellent to each other: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
