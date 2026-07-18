## SUMMARY

Verified on this machine (macOS 26.2, arm64, Node v22.22.0/npm 10.9.4): all required binaries are present except pnpm (absent, but not needed — npm workspaces confirmed fully functional via a live empirical test). The default `git` on PATH is a stale 2.14.1 relic in /usr/local/bin; a newer git (2.50.1, Apple Git-155) exists at /usr/bin/git and should be preferred. Cross-checked every proposed npm package against the live npm registry (not just docs) and found one real, must-fix version trap: `typescript-eslint`'s peer range is `>=4.8.4 <6.1.0`, but npm's `typescript@latest` is now 7.0.2 (the Go-based tsgo rewrite) — pinning "latest" typescript will silently break typed ESLint linting; pin `typescript` to `6.0.3` instead. Everything else (React 19.2.7, Vite 8.1.5, @xyflow/react 12.11.2, Zustand 5.0.14, xterm.js's `@xterm/*` scoped packages, ESLint 10 flat config + typescript-eslint 8, Vitest 4, Playwright 1.61) lines up cleanly on current majors with no other peer conflicts found. Disk space is a genuine local risk: only ~14GB free on a 926GB, 99%-full volume.

## FINDINGS

## 1. Binary verification (separate commands, all executed individually)

| Binary               | Path                                                               | Version                                                                                                   |
| -------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| node                 | `/usr/local/bin/node`                                              | v22.22.0 (darwin x64 — Rosetta/Intel node on arm64 mac; `uname -m` = arm64)                               |
| npm                  | `/usr/local/bin/npm`                                               | 10.9.4                                                                                                    |
| pnpm                 | not found                                                          | `which pnpm` exits 1 — confirmed absent, not installed                                                    |
| jq                   | `/usr/bin/jq`                                                      | jq-1.7.1-apple                                                                                            |
| cargo                | `<HOME>/.cargo/bin/cargo`                                          | 1.96.0 (30a34c682 2026-05-25)                                                                             |
| git (`which git`)    | `/usr/local/bin/git`                                               | **2.14.1** (stale — this is what "git reported 2.14.1" was)                                               |
| git (Apple CLT)      | `/usr/bin/git`                                                     | **2.50.1 (Apple Git-155)** — newest available, confirmed present                                          |
| git (Homebrew arm64) | `/opt/homebrew/bin/git` → symlink → `../Cellar/git/2.37.2/bin/git` | 2.37.2 — also newer than the PATH-resolved one, but itself stale for Homebrew (should be `brew upgrade`d) |

**Root cause**: `$PATH` has `/usr/local/bin` before both `/opt/homebrew/bin` and `/usr/bin`, so the oldest of the three git binaries wins. This is a leftover Intel/legacy install at `/usr/local/bin/git` (2017-era 2.14.1), unrelated to Homebrew's arm64 tree. This only affects local dev (hooks, worktrees, etc.) — GitHub Actions runners bring their own recent git and are unaffected.

macOS: 26.2 (build 25C56), arm64. Node confirmed 22.22.0 via `process.version`.

## 2. Package validation — resolved via context7 MCP (resolve-library-id + query-docs) AND cross-checked against the live npm registry (`npm view <pkg> version/peerDependencies/engines/dist-tags`, registry reachable at https://registry.npmjs.org/). Registry data is ground truth; context7 docs sometimes reflect repo `main`/dev branches (e.g. showed Vitest "5.0.0-beta.5" and TypeScript "6.0.0-dev" from source, not what's actually published as `latest`).

**Recommended pinned versions** (exact, `--save-exact` style — no carets, per the compatibility notes below):

| Package                   | Version   | Notes                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| typescript                | **6.0.3** | ⚠️ NOT `latest`. See incompatibility section.                                                                                                                                                                                                                                                                                  |
| react                     | 19.2.7    | npm `latest` dist-tag (context7's repo-main showed 19.3.0-in-dev, not yet published)                                                                                                                                                                                                                                           |
| react-dom                 | 19.2.7    | `react-dom@19.2.7` peerDependencies requires `react: "^19.2.7"` — exact-version runtime check (`ensureCorrectIsomorphicReactVersion`) throws if react/react-dom versions differ, so these two must always move together                                                                                                        |
| vite                      | 8.1.5     | Vite 8 is now current stable (Vite 7 has been superseded); engines: `"node": "^20.19.0 \|\| >=22.12.0"` — Node 22.22.0 satisfies this                                                                                                                                                                                          |
| @vitejs/plugin-react      | 6.0.3     | peerDependencies: `"vite": "^8.0.0"` — **only** compatible with Vite 8, not Vite 7. Since Vite 8 is latest anyway, no conflict if you take both at latest.                                                                                                                                                                     |
| @xyflow/react             | 12.11.2   | (React Flow v12) peerDependencies: `react >=17`, `react-dom >=17` — fully compatible with React 19.2.7, no incompatibility here despite the prompt's caution                                                                                                                                                                   |
| zustand                   | 5.0.14    | peerDependencies: `react >=18.0.0`; `@types/react`, `immer`, `use-sync-external-store` are all `peerDependenciesMeta.optional: true` — no extra installs needed for basic usage                                                                                                                                                |
| @xterm/xterm              | 6.0.0     | current org-scoped package                                                                                                                                                                                                                                                                                                     |
| @xterm/addon-fit          | 0.11.0    |                                                                                                                                                                                                                                                                                                                                |
| @xterm/addon-webgl        | 0.19.0    |                                                                                                                                                                                                                                                                                                                                |
| (old) xterm               | —         | confirmed via `npm view xterm deprecated`: **"This package is now deprecated. Move to @xterm/xterm instead."** — do not use                                                                                                                                                                                                    |
| elkjs                     | 0.12.0    | evaluated, not chosen as primary (see layout decision)                                                                                                                                                                                                                                                                         |
| @dagrejs/dagre            | 3.0.0     | **recommended** for the DAG layout (see decision below)                                                                                                                                                                                                                                                                        |
| ws                        | 8.21.1    | engines: `node >=10.0.0` (trivially satisfied). Still required — Node 22 only added a browser-spec `WebSocket` **client** global (via `--experimental-websocket`/stable fetch-spec client); there is no built-in Node **server**-side WebSocket implementation, so `ws`'s `WebSocketServer` is still necessary for the bridge. |
| vitest                    | 4.1.10    | peerDependencies: `"vite": "^6.0.0 \|\| ^7.0.0 \|\| ^8.0.0"` — compatible with Vite 8.1.5; engines: `node "^20.0.0 \|\| ^22.0.0 \|\| >=24.0.0"` — compatible                                                                                                                                                                   |
| @playwright/test          | 1.61.1    | engines: `node >=18` — compatible                                                                                                                                                                                                                                                                                              |
| eslint                    | 10.7.0    | flat config (`eslint.config.js`) has been the **only** supported format since 9.0.0 (legacy `.eslintrc` fully removed in 10.0.0's breaking changes). engines: `"node": "^20.19.0 \|\| ^22.13.0 \|\| >=24"` — Node 22.22.0 satisfies `^22.13.0`                                                                                 |
| typescript-eslint         | 8.64.0    | peerDependencies: `"eslint": "^8.57.0 \|\| ^9.0.0 \|\| ^10.0.0"` (compatible with eslint 10.7.0) and **`"typescript": ">=4.8.4 <6.1.0"`** — this is the critical constraint, see below                                                                                                                                         |
| prettier                  | 3.9.5     | Prettier's own install docs explicitly recommend `--save-exact` pinning (not caret) since formatting output can shift between minor versions                                                                                                                                                                                   |
| concurrently              | 10.0.3    | for the one-command dev script                                                                                                                                                                                                                                                                                                 |
| tsx                       | 4.23.1    | recommended for running/dev-watching the bridge server (zero-build TS execution + watch mode)                                                                                                                                                                                                                                  |
| tsup                      | 8.5.1     | only needed later if/when the bridge needs a proper bundled `dist/` build (e.g. for packaging); not required for local dev — `tsx watch` covers dev, plain `tsc --noEmit` covers typechecking                                                                                                                                  |
| zod                       | 4.4.3     | v4 line. Breaking changes vs v3 relevant to an event-schema use case: `z.email()/z.uuid()/z.url()` are now top-level functions (old `.string().email()` form deprecated); `.merge()` deprecated in favor of `.extend()`; `z.record()` now requires **two** args (key schema + value schema) instead of one                     |
| @tauri-apps/cli (roadmap) | 2.11.4    | still v2 line — no v3 stable exists yet, so "Tauri v2, roadmap-only" is currently accurate and doesn't need re-evaluating                                                                                                                                                                                                      |
| @tauri-apps/api (roadmap) | 2.11.1    |                                                                                                                                                                                                                                                                                                                                |

## 3. THE incompatibility to avoid (found by cross-checking, not assumed)

`npm view typescript dist-tags --json` shows:

```json
{
  "beta": "6.0.0-beta",
  "rc": "7.0.1-rc",
  "latest": "7.0.2",
  "next": "7.1.0-dev.20260717.1"
}
```

TypeScript's `latest` npm tag is now **7.0.2** — the Go-native compiler rewrite ("tsgo"), which the TS team promoted straight to `latest` (the "6.0" JS-based line topped out at 6.0.3 and was never made `latest`). But `typescript-eslint@8.64.0`'s peer range is `">=4.8.4 <6.1.0"` — it does **not** support TypeScript 7.x at all. If a scaffold naively runs `npm install -D typescript@latest`, ESLint's typed-linting (`typescript-eslint`) will emit "unsupported TypeScript version" warnings and may misparse or fail on newer syntax. **Fix: pin `typescript` to `6.0.3` explicitly**, not `latest`/`^`. Revisit when typescript-eslint ships TS7 support (tracked upstream; their CHANGELOG shows ESLint-v10 support landed but no TS7 peer-range bump yet as of this check).

No other peer-dependency conflicts were found: React 19.2.7 ↔ @xyflow/react (>=17) ✅, React 19.2.7 ↔ zustand (>=18) ✅, Vite 8.1.5 ↔ @vitejs/plugin-react (^8.0.0) ✅, Vite 8.1.5 ↔ vitest (^6||^7||^8) ✅, ESLint 10.7.0 ↔ typescript-eslint (^8.57||^9||^10) ✅, Node 22.22.0 ↔ every engines field checked (vite, eslint, vitest, playwright, ws) ✅.

## 4. elkjs vs @dagrejs/dagre — decision: **use @dagrejs/dagre**

Both were queried via context7. For "ranked left-to-right DAG layout" in an interactive dashboard:

- **@dagrejs/dagre** (v3.0.0): synchronous API, set `rankdir: "LR"` and call `layout(g)` — done. It's the layout engine React Flow's own official examples use for exactly this ranked/hierarchical case. Small footprint, no async/worker plumbing needed, which matters for a dashboard that re-lays-out frequently as new nodes stream in over the WebSocket connection from the bridge.
- **elkjs** (v0.12.0): more sophisticated (orthogonal edge routing, compound/hierarchical nodes, port constraints) but async-by-default (`elk.layout()` returns a Promise, recommended to run in a Web Worker for larger graphs), heavier bundle, and pre-1.0 (0.x) versioning signals API is still settling.

For a simple ranked left-to-right DAG (the described use case), dagre's simplicity and synchronous re-layout model is the better fit. Revisit elkjs only if the graph later needs compound/nested node groups or dense edge-crossing minimization at real scale (hundreds+ of nodes).

## 5. npm workspaces — empirically verified working on this machine (not just asserted)

Built a throwaway workspace tree at `packages/protocol`, `packages/bridge`, `apps/ui` with a root `package.json` declaring `"workspaces": ["packages/*", "apps/*"]`, ran `npm install`, and confirmed:

- `node_modules/@wstest/{protocol,bridge,ui}` are correctly symlinked to their workspace folders
- `npm run ping --workspaces --if-present` runs the script in every workspace
- `npm run ping -w @wstest/bridge` runs the script scoped to a single named workspace
- A workspace package (`apps/ui`) successfully `require()`s another workspace package (`@wstest/protocol`) via the symlink, with zero extra config

npm 10.9.4's workspace features are fully sufficient for the proposed `packages/protocol`, `packages/bridge`, `apps/ui` layout — no need for pnpm.

## 6. Recommended monorepo layout

```
root/
  package.json                # "workspaces": ["packages/*", "apps/*"]
  packages/
    protocol/                 # shared event schema (zod) + TS types, published to neither packages/bridge nor apps/ui — just workspace-linked
    bridge/                   # Node WS server (ws + protocol), tsx for dev/run
  apps/
    ui/                       # Vite + React + React Flow + xterm.js + Zustand dashboard
  (roadmap, not built now)
  apps/desktop/                # Tauri v2 wrapper embedding apps/ui's build output
```

## 7. One-command dev story

Root `package.json`:

```json
"scripts": {
  "dev": "concurrently -n bridge,ui -c blue,green \"npm run dev -w packages/bridge\" \"npm run dev -w apps/ui\""
}
```

`packages/bridge/package.json`: `"dev": "tsx watch src/index.ts"`
`apps/ui/package.json`: `"dev": "vite"`

`npm run dev` at the root spawns both processes concurrently with labeled, colored output; `concurrently`'s default kill-others-on-fail-friendly behavior keeps both processes tied to one Ctrl-C.

## 8. Playwright install story on this mac

- `npx playwright install chromium` — installs into `~/Library/Caches/ms-playwright/`
- **Already cached** on this machine: `chromium-1228` at 344MB, plus older `chromium-1208`, two `webkit` builds, `firefox`, `ffmpeg`, and `chromium_headless_shell` builds — cache dir totals **1.5GB** already. If `@playwright/test@1.61.1`'s bundled browser revision matches what's cached, the incremental cost could be near-zero; if it needs a newer revision, budget the documented "few hundred MB" (historically 300-450MB for chromium alone).
- `@playwright/test` engines: `node >=18` — satisfied.
- Since only Chromium is needed for this project's e2e tests (not the full browser matrix), `npx playwright install chromium` (not the bare `install`, which pulls all three engines) is the right, disk-conscious command.

## 9. Disk space — flagged risk, not project-caused

`df -h /System/Volumes/Data`: **926Gi total, 846Gi used, only 14Gi free, 99% capacity**. `diskutil info /` confirms container free space ≈ 15.1GB. This is a real constraint independent of this project: a fresh monorepo (node_modules across 3 workspaces, Playwright browser cache, and eventually a Rust/Cargo `target/` dir once the Tauri roadmap item starts) will each eat hundreds of MB to low-GBs. 14GB is enough headroom to bootstrap this specific project (workspace node_modules typically 300-600MB with these deps, Playwright chromium ~350MB if not already cached), but it leaves very little margin — general disk cleanup on this machine is worth doing before or shortly after starting, especially before ever touching the Tauri/Rust roadmap item (Cargo build artifacts for a Tauri app can easily run 1-3GB per target).

## 10. GitHub Actions CI note

Runners provide their own current Node/git/npm — the local git 2.14.1 issue does not propagate to CI. Recommend `actions/setup-node@v4` with `node-version: 22` and `cache: npm`, then `npm ci`, `npm run -ws lint`, `npm run -ws typecheck` (or `tsc -b` at root if using project references), `npx playwright install --with-deps chromium`, `npm run -ws test` (vitest) and a separate Playwright job/step.

## RISKS

- **TypeScript's "latest" dist-tag pointing at the still-young 7.0.x Go rewrite is a moving target.** This was confirmed live against the npm registry today (2026-07-17); if the user reads this later, re-verify with `npm view typescript-eslint peerDependencies` before trusting the "pin to 6.0.3" advice — typescript-eslint may have shipped TS7 support by then, in which case the constraint disappears.
- **Node binary is x64 (`darwin x64`) running via Rosetta on an arm64 Mac** (`uname -m` = arm64, but `node -e process.arch` = x64, and node/npm live under `/usr/local/bin` — the Intel Homebrew prefix). This wasn't asked about but is worth the user's awareness: native modules that need to match CPU arch (any future native Node addon, or the eventual Tauri/Rust side which will build natively for arm64) could hit an x64-vs-arm64 mismatch. Not verified further since it's out of scope of the ask, but flagging as a latent risk for the Tauri roadmap phase specifically, since Cargo/Rust there would build arm64 while Node here runs x64.
- **Playwright's exact required browser revision for `@playwright/test@1.61.1` was not directly diffed against the cached `chromium-1228` build** — I confirmed the cache exists and its size, but didn't run `npx playwright install --list` or a real `npx playwright install chromium` to prove zero/near-zero incremental download, since that would make a real network call as an unrequested side effect. Treat the "near-zero if cached" claim as a reasonable inference, not a confirmed download-free run.
- **Disk space (14GB free, 99% full) is a live risk, not a hypothetical one.** It's enough for this project's immediate footprint but leaves little room for mistakes (e.g., an accidental `npx playwright install` with all three browsers instead of just chromium would eat a large fraction of remaining space).
- **The `/opt/homebrew/bin/git` Homebrew formula (2.37.2) is itself stale** — a `brew update && brew outdated` was not run, so the actual latest Homebrew git version available wasn't confirmed; the recommendation to `brew upgrade git` assumes Homebrew's index would pull something newer than 2.37.2, which is nearly certain but not directly checked.
- All "current stable" version claims reflect the npm registry state at the moment of this check (2026-07-17); given how fast several of these packages are moving right now (Vite 8, ESLint 10, TypeScript 7 all recently promoted), re-verify pinned versions with `npm view <pkg> version` again at actual scaffold time rather than trusting this snapshot indefinitely.

## RECOMMENDATIONS

1. **Pin `typescript` to `6.0.3`, never `latest`/`^`, in this project.** `typescript-eslint@8.64.0`'s peer range (`>=4.8.4 <6.1.0`) excludes the new `7.x` "latest" tag entirely. This is the single highest-value catch from this validation pass — add a comment in `package.json` or a CI check (`npm ls typescript` version assertion) so a future `npm update` doesn't silently jump to TS7 and break typed linting.

2. **Fix local git before relying on it for anything version-sensitive** (husky hooks, `git worktree`, signed commits). Two options, pick one:
   - Cheap/local: add `alias git=/usr/bin/git` to the shell rc, or explicitly invoke `/usr/bin/git` (2.50.1) in any project tooling/scripts that shell out to git.
   - Cleaner: `brew upgrade git` (refreshes the stale 2.37.2 at `/opt/homebrew/bin/git`) and reorder `$PATH` so `/opt/homebrew/bin` (or `/usr/bin`) precedes `/usr/local/bin`; separately, identify and remove/rename the orphaned `/usr/local/bin/git` (2.14.1, clearly a leftover Intel/manual install, not Homebrew-managed) since nothing on this arm64 machine should need it.
     Do **not** touch global PATH without confirming it won't break other tools that may intentionally resolve to `/usr/local/bin` first — flagging this for the user's decision rather than changing it unilaterally.

3. **Use npm workspaces (npm 10.9.4), skip pnpm.** Empirically confirmed sufficient — no reason to introduce a second package manager pnpm isn't installed and isn't needed.

4. **Layout**: `packages/protocol` (zod schemas + shared types), `packages/bridge` (ws server + tsx dev), `apps/ui` (Vite/React dashboard), with `apps/desktop` reserved but unbuilt for the Tauri v2 roadmap item.

5. **Layout engine: `@dagrejs/dagre`**, not elkjs, for the ranked left-to-right DAG — simpler synchronous API fits a dashboard re-laying-out on every WebSocket-streamed node addition; revisit elkjs only if compound/nested nodes or large-graph edge-crossing minimization becomes a real requirement.

6. **Keep `tsx` for dev; add `tsup` only later** if/when the bridge needs a real bundled `dist/` for distribution — don't add build complexity the local-only tool doesn't need yet.

7. **Before scaffolding, run a general disk cleanup pass** (14GB free / 99% full on the whole Data volume) — not blocking for this specific project's initial footprint, but the margin is thin, and the Tauri roadmap item (Cargo build artifacts) will need meaningfully more headroom than 14GB when that phase starts.

8. **CI**: `actions/setup-node@v4` with Node 22, `npm ci`, `npx playwright install --with-deps chromium` (chromium-only, not the full matrix), run vitest and Playwright as separate steps/jobs so a flaky browser test doesn't mask unit-test signal.
