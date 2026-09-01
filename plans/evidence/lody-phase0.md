# Lody sessions — phase 0 spike results

Measured 2026-08-29 on branch `lody-sessions`, against upstream Lody
`966623d0` and npm `lody@0.88.1`. Plan of record: `plans/LODY-SESSIONS.md`.

Phase 0 has four exit tests (§10). All four pass. The Tailwind one passes with
a **verdict of "bleed found, and it is bounded"** — the precise set is below,
and it is pinned by a test so it cannot widen unnoticed.

| Exit test | Verdict | Evidence |
|---|---|---|
| 1. Subtree added, pinned, fully tracked | PASS | `vendor/lody/UPSTREAM.md`, 3885 files tracked |
| 2. `SessionChatStream` + `ChatComposer` + `LoroSidebar` body render from fixtures | PASS | `packages/webapp/test/lody-session-surface-spike.test.tsx` |
| 3. Tailwind containment | BLEED FOUND (bounded, layer holds where it can) | `packages/webapp/test/lody-tailwind-containment.test.ts` |
| 4. loro-repo ⇄ loro-websocket echo + resume + ephemeral | PASS | `packages/webapp/test/lody-transport-echo.test.ts` |

---

## 1. Subtree

`git subtree add --prefix vendor/lody https://github.com/LodyAI/Lody 966623d0… --squash`.

The local mirror at `/workspace/lody-upstream` could **not** be used as the
source: it is a shallow clone, and `git subtree add` from a shallow repo fails
with `rejected … because shallow roots are not allowed to be updated`. Fetching
the same SHA from GitHub gives the identical tree (`diff -rq` against the
mirror is empty apart from the six empty submodule directories).

- 3885 files tracked, matching `git ls-files` in the mirror exactly.
- `git status --porcelain --ignored vendor/lody` is empty: nothing in the
  subtree collides with a root `.gitignore` rule.
- The six `acp-extension-*` submodules arrive as gitlinks with no contents,
  which is what §5.1 expects. The one consequence for the renderer is recorded
  in `vendor/lody/UPSTREAM.md`.

## 2. Vendored render

`packages/webapp/src/lody/SessionSurfaceSpike.tsx` mounts, from fixture props
mirrored off their Storybook stories, with no daemon, no CRDT and no network:

- `SessionChatStreamView` + `MessageRowView` (`components/ai-gui/view.tsx`) —
  renders the user turn, the folded "Worked for 42s" activity group, and the
  final answer.
- `ChatComposer` with both `OptionSelector` pickers and the mention textarea.
- `LoroSidebar` — Chats rows, a repo group with diff badges, the
  `afterSessionListContent` slot that phase 4 will inject Terminals through,
  and the sidebar footer.

Reachable in dev at `#lody-spike` with `VITE_LODY_SESSIONS_ENABLED=true`. The
flag defaults **off** (`packages/webapp/src/lody/flag.ts`).

### What it took

- **85 runtime dependencies + 5 dev dependencies** added to
  `packages/webapp/package.json`, resolved from `vendor/lody/pnpm-workspace.yaml`'s
  catalog where it pins one. `package-lock.json` grows from 396 to 895 entries.
  The dev five are `tailwindcss`, `@tailwindcss/vite`,
  `@tailwindcss/container-queries`, `vite-plugin-wasm` and `postcss` (the
  containment test's parser).
- **`.npmrc` with `legacy-peer-deps=true`.** Several vendored packages declare
  `peerOptional typescript@^5`; this repo is on TypeScript 7, and npm treats an
  unsatisfiable *optional* peer as a hard `ERESOLVE`. `npm ci` in CI needs the
  same relaxation the first install needed.
- **One npm `override`: `convex > esbuild = 0.28.1`.** `convex` pins
  `esbuild@0.27.0`, whose postinstall validates the binary it finds and aborts
  the whole install against the hoisted 0.28.1
  (`Expected "0.27.0" but got "0.28.1"`). `npm install` survived it on a warm
  tree; `npm ci` did not, so CI would have found this and nobody else would.
  Lody carry the same class of override in `pnpm-workspace.yaml`
  (`tsx@4.21.0>esbuild: 0.27.0`).
- `npm ci` was run from an empty `node_modules` to prove the above: it installs
  736 packages, applies all four patches from the postinstall, and exits 0.
- **Four Vite changes** (`packages/webapp/vite.config.ts` +
  `src/lody/vendor-bridge.ts`): the `@lody/*` and `@/` aliases that stand in for
  their pnpm workspace, `@tailwindcss/vite`, `vite-plugin-wasm`, React dedupe,
  and `worker: { format: "es" }` — the vendored workers reach WASM through
  top-level await, which Vite's default `iife` worker format cannot express.
- **Two ported plugin rules** from `apps/electron/electron.vite.config.ts`:
  `shiki/bundle/full` → `shiki`, and the loro/zstd `?url` WASM rewrite. Their
  `packages/components/vite-renderer-bundle-aliases.ts` cannot be imported
  directly — it resolves a `node_modules` path next to itself at module load,
  which only exists under pnpm's nested layout.
- `vite-plugin-top-level-await` was tried and dropped: it requires a top-level
  `rollup` module, and Vite 8 bundles rolldown instead. Nothing needed it once
  the worker format was set.
- **i18next initialized with `en` only**, from `vendor/lody/locales/en.json`,
  in `src/lody/i18n.ts`. Their own `@lody/components/i18n` entry loads both
  languages and pulls in OneSignal and their settings atoms.

### Stubs and providers written instead of editing the vendor tree

- `acp-extension-dsh/capabilities` → `src/lody/stubs/…` (empty selector
  constants; the package is an empty submodule).
- `PlatformContext` → `createLocalPlatformProvider` in `src/lody/platform.tsx`.
- `AuthenticatedConvexContext` → the settled signed-out value from their own
  Storybook preview. **This one is a phase-2 requirement, not spike scaffolding:**
  the composer's mention sources call `useAuthenticatedConvex`, which throws
  without a provider, even though `cloudApi` is `null`. Capability gating does
  not reach that far.

### Dependency patches

Lody has eight `patchedDependencies`. Four are needed here and are applied by
`scripts/apply-vendor-patches.mjs` from a `postinstall`, reading the patch files
**in place** from `vendor/lody/patches/` (a copy under `patches/` would be a
second thing to keep in step with every subtree pull):

`loro-repo@0.20.0`, `@pierre/diffs@1.0.10`, `react-photo-view@1.2.7`,
`mdast-util-gfm-autolink-literal@2.0.1`.

Two mechanical findings worth carrying forward:

- **`patch-package` refuses all four files** (it fails before reporting a
  reason), so the script uses `git apply`. Their bytes are applied unchanged,
  which keeps the §5.4 audit a plain diff of the vendor tree.
- **`git apply` silently skips ignored paths and still exits 0.** `node_modules`
  is git-ignored and inside this repo, so the first version of the script
  reported four successes and changed nothing. `GIT_CEILING_DIRECTORIES` set to
  `node_modules` stops git's upward search and makes it treat the package as
  plain files. `loro-repo.patch` additionally needs `--unidiff-zero`: it is a
  zero-context diff.
- `remend@1.3.0` is skipped — npm resolves 1.3.1 and the patch does not target
  it. The other three cover Electron, the Lody cloud login, and their build
  tooling, none of which we run.

## 3. Tailwind containment — VERDICT

**The cascade layer works, and it is not containment. Bleed is real, bounded,
and now pinned.**

### How the sheet is layered

The obvious spelling does not compile:

```css
@import "…/components/src/tailwind/index.css" layer(lody);   /* ✗ */
```

> `Error: @utility cannot be nested.`

Their entry declares `@utility` at the top level, and Tailwind v4 rejects
`@utility` inside a layer. Since `vendor/lody` may not be edited, the sheet is
imported unlayered and its **compiled output** is wrapped by
`lodyCascadeLayerPlugin` in `src/lody/vendor-bridge.ts`, which runs immediately
after `tailwindcss()` in the plugin array. The shipped CSS starts with
`@layer lody {`.

### What the layer buys

Every stylesheet under `packages/webapp/src` is unlayered, and an unlayered
declaration beats a layered one regardless of specificity. So on any property
our CSS declares for an element, we win — unconditionally, including against
their higher-specificity `.dark` rules.

### What it cannot buy

A layer changes **who wins**, never **which elements match**. Tailwind's
preflight and their `@layer base` block select `*`, `html`, `body`, `button`
and `::selection` document-wide. Any property our CSS does not declare on a
native element outside the session surface is theirs.

Measured per probe element by `lody-tailwind-containment.test.ts`, which pins
the exact lists. Shorthands are expanded on both sides, so our `background: …`
correctly outranks their `background-color: …` and does not appear as bleed.
Custom properties are counted separately: 314 theme variables land on `:root`
and 94 `--tw-*` resets land on every element, and both are inert until
something reads them.

Six properties reach **every** element, from the `*` and `*, ::before, ::after`
preflight rules:

`-webkit-text-size-adjust`, `animation-duration`, `animation-iteration-count`,
`outline-color`, `scroll-behavior`, `transition-duration`

On top of those (longhand families collapsed for reading; the test pins each
longhand):

| Probe | Additional bleeding properties | Total |
|---|---|---|
| `html` | `-webkit-tap-highlight-color`, `border*`, `padding*`, `font-feature-settings`, `font-variation-settings`, `line-height`, `tab-size` | 20 |
| `body` | `-webkit-tap-highlight-color`, `border*`, `padding*`, `-moz-osx-font-smoothing`, `-webkit-font-smoothing`, `color-scheme`, `counter-reset`, `font-family`, `font-size`, `line-height` | 23 |
| `#root` | `-webkit-tap-highlight-color`, `border*`, `padding*` | 16 |
| `.shell-s` (rail session row) | `-webkit-tap-highlight-color`, `margin*` | 12 |
| `.files-tree-row` (Finder row) | `-webkit-tap-highlight-color`, `border*`, `margin*`, `padding*` | 21 |
| native `<button>` | `appearance`, `background-color`, `border*`, `border-radius`, `color`, `cursor`, `font-feature-settings`, `font-variation-settings`, `letter-spacing`, `margin*`, `opacity`, `padding*` | 29 |
| native `<input>` | as `<button>` minus `appearance`/`cursor`, plus `-webkit-tap-highlight-color` | 28 |
| native `<a>` | `-webkit-tap-highlight-color`, `border*`, `margin*`, `padding*`, `text-decoration*`, `-webkit-text-decoration` | 27 |
| native `<h1>` | `-webkit-tap-highlight-color`, `border*`, `margin*`, `padding*`, `font-size`, `font-weight` | 23 |
| native `<ul>` | `-webkit-tap-highlight-color`, `border*`, `margin*`, `padding*`, `list-style*` | 25 |
| native `<img>` | `-webkit-tap-highlight-color`, `border*`, `margin*`, `padding*`, `display`, `height`, `max-width`, `vertical-align` | 25 |
| native `<table>` | `-webkit-tap-highlight-color`, `border*`, `border-collapse`, `margin*`, `padding*`, `text-indent` | 23 |

Reading it: `box-sizing` on `*`, `background`, `color` and `overflow` on
`html`/`body`, and `font` on form controls are all **already declared** by
`packages/webapp/src/webapp-base.css`, so the layer protects every one of them —
that is the layer earning its keep. What lands is the rest of preflight:
`border-width: 0` and `border-style: solid` on `*`, headings losing their size
and weight, lists losing markers, buttons losing their native chrome, images
becoming `display: block`, and `body` taking Lody's `font-family`/`font-size`
(a direct declaration on `body` beats our inherited `:root` font, whatever the
layer).

Two of those matter today for surfaces the product actually renders:
`.shell-s` and `.files-tree-row` pick up `margin` and `border-*`. Neither is set
by our CSS, so both are new values on rows the user looks at all day. The rest
land on elements our shell rarely uses bare — which is why the verdict is
"bounded" rather than "harmless".

### Bleed in the other direction

Five custom-property names are defined by both trees:
`--font-mono`, `--hover`, `--muted`, `--terminal-background`, `--terminal-selection`.

Because ours are unlayered they win **inside** `.lody-surface` too. Lody reads
these as HSL triplets (`hsl(var(--muted))`), and ours hold finished colors, so
those four resolve to nothing in their components. This is a phase-3 job, and
it points at the answer §5.3 already chose: redeclare their theme on the
surface, or ship a "Blitz" VS Code theme through their runtime theme engine
rather than fighting the variables.

### The iframe fallback is NOT built (per instruction)

The ladder in §7.4 stays where it is. What phase 3 should try first, in order:

1. Scope the sheet with `@scope (.lody-surface)` around the compiled output —
   the same post-compile wrap already in place, one at-rule deeper. This is
   cheap to test and would remove the entire outbound table above.
2. If `@scope` support or Radix's body portals rule that out, the iframe.

### On the test method

jsdom implements no cascade layers — it parses `@layer` into a
`CSSLayerBlockRule` and then its cascade ignores the contents, so a naive
"computed styles are unchanged" assertion would pass no matter what the sheet
said. The test therefore never consults jsdom's cascade. It parses the compiled
sheet with **postcss**, flattens layers and conditional at-rules away, uses
jsdom only as a selector engine (`Element.matches`), and reports the
declared-property difference described above. Four guards keep it honest:

1. The jsdom limitation itself is pinned by a test, so the reasoning cannot rot.
2. A structural assertion that the compiled sheet's only top-level node is
   `@layer lody` — if the wrapper is lost, that fails immediately.
3. A positive control asserting the analysis sees more than 50 properties on
   `body`, so a parse failure cannot masquerade as containment.
4. The per-probe result is pinned exactly, so the set can only change loudly.

## 4. Transport — loro-repo ⇄ loro-websocket

`packages/webapp/test/lody-transport-echo.test.ts` (node environment, real
localhost WebSocket, real `SimpleServer`):

- Two independent `LoroRepo` instances join the same doc room through
  `loro-repo/transport/websocket`. Side 1 writes; side 2 converges.
- Side 2's transport is removed entirely (`hasTransport() === false`), side 1
  writes again, then a fresh `WebSocketTransportAdapter` is added and
  `refreshTransportRoutes()` called. Side 2 catches up with the missed edit.
- Both pass in ~200 ms.

This settles §11's first risk: **no daemon change is needed for the sync half.**
`loro-websocket`'s `SimpleServer` is a room relay over `loro-protocol`; the repo
attaches as an ordinary client. The `loro-data-plane-relay` fallback is not
required.

### Ephemeral / presence — YES

**`loro-websocket@0.6.2` carries ephemeral messages, and `loro-repo@0.20.0`
exposes them.** Confirmed two ways:

- `SimpleServer` registers a `LoroEphemeralServerAdaptor` for the
  `LoroEphemeralStore` CRDT type (`%EPH`) among its default descriptors, with
  `shouldPersist: false` and `allowBackfillWhenNoOtherClients: false` — relayed
  live, never stored, no backfill.
- `WebSocketTransportAdapter.joinEphemeralRoom(roomId)` returns a subscription
  carrying a `loro-crdt` `EphemeralStore`, and `LoroRepo.joinEphemeralRoom`
  routes to the transport marked `{ ephemeral: true }` (or the only one).
- The test writes presence on side 1 and reads the same value on side 2.

So sharing and live-status (§0.1, phase 6) can ride the same socket. Two things
follow for phase 6: `joinEphemeralRoom` **throws** with zero registered
transports rather than queueing — ephemeral state has no pending delivery to
defer — and presence rooms need their own ACL entry at the relay, since they are
a different room family from `session-<id>`.

## Bundle measurement

Production build (`npm run build -w @blitzos/webapp`), with the spike included.

| | Baseline (spike branch removed) | With the spike | Δ |
|---|---|---|---|
| `index.html` entry payload | 2100.5 KB raw | **2102.4 KB raw / 542.0 KB gzip** | **+1.9 KB** |
| Entry CSS | `index-d63x68BK.css`, 190.8 KB | `index-d63x68BK.css`, 190.8 KB — **byte-identical hash** | 0 |
| Whole `dist/` | 4.8 MB | 40.8 MB | +36 MB, all lazy |
| JS chunks | 118 | 851 | +733 |

**Lazy boundaries hold. Nothing needed enforcing.** The spike is one dynamic
import, so the whole vendored renderer lands in `SessionSurfaceSpike-*.js`
(3495 KB raw / **849 KB gzip**) plus `SessionSurfaceSpike-*.css` (445 KB raw /
**85 KB gzip**). The +1.9 KB on the entry is the flag module and the import
helper. The entry CSS hash being unchanged is the sharpest single fact here:
none of Tailwind's output reaches the main stylesheet.

Checked explicitly for the heavy libraries §11 names:

- **monaco, three, elkjs: not in any chunk.** They are never imported by the
  three components the spike mounts.
- **mermaid: not bundled.** Streamdown registers a mermaid plugin behind its own
  lazy loader; the string appears in the spike chunk, the library does not
  (elkjs, which mermaid needs, is absent everywhere). The `mermaid` in the entry
  chunk is a `vscode-material-icons` icon name and predates this branch.
- WASM: 5.4 MB across three files (`loro_wasm` 3.1 MB, `flock_wasm` 2.2 MB,
  `zstd` 246 KB), all lazily fetched by the spike chunk.

Two size facts to act on before phase 3, neither blocking:

- **Shiki's language set is emitted twice** — `emacs-lisp`, `cpp`, `wasm` and
  friends each appear as two identically-sized chunks. The worker build is a
  separate Rollup pass with its own copy of the graph (`@pierre/diffs` uses
  worker pools for syntax work). ~13 MB of the 27 MB of JS is the duplicate.
- **163 font files, 2.4 MB**, from their `@fontsource/inter` and
  `@fontsource/jetbrains-mono` imports. Per-`unicode-range` `@font-face`, so a
  browser fetches a handful — but they are emitted whether or not the Blitz
  theme ends up using either family.

## Blockers and open items for phases 1–2

0. **`.oxlintrc.json`'s `ignorePatterns` are inert in oxlint 1.79.** Found while
   excluding the vendor tree: no pattern spelling suppresses anything —
   verified by pointing an entry at `packages/webapp/src/**` and watching its
   findings still appear. The existing entries (`packages/broker/internal/vendor/**`
   and the rest) are equally dead. `npm run lint` now passes
   `--ignore-pattern "**/vendor/**"` on the command line, where oxlint does
   honour it, and `lint:gate` was already safe because it lints `packages` only,
   so no vendor finding can ever enter `lint-baseline.json`. `vendor/lody/**`
   is still listed in `ignorePatterns` beside its inert peers, so the intent is
   declared where a reader looks for it and a future oxlint that honours the
   field does the right thing without another change.
1. **`LoroSidebar` has no header/footer suppression props.** §0.3 requires them
   "via props, not source edits", and none exist at `966623d0`
   (`afterSessionListContent` is the only slot). Phase 4 must add them upstream,
   contribute them, or accept a seam patch. Recorded in `BLITZ-PATCHES.md`.
2. **The vendor tree is excluded from our typecheck**, via shorthand ambient
   module declarations in `src/lody/vendor-modules.d.ts`. Every value crossing
   the seam is `any`, so `src/lody/spike-types.ts` states our side of each prop
   contract locally. Typechecking their tree here would mean adopting their
   ~140 dependencies, their compiler options, and their type-only imports into
   `apps/electron/src/main/**`. Phase 2 should decide whether the runtime seam
   earns hand-written declarations or a second tsconfig project.
3. **`@lody/configs` is installed as a `file:` dependency** so that their
   `@config "../../tailwind.config.js"` can resolve `@lody/configs/tailwind-preset`
   through ordinary Node resolution. It is the only vendor package installed
   rather than aliased; the others carry `workspace:*` dependencies npm cannot
   parse.
4. **npm `lody` is 0.88.1 while the subtree's `apps/cli` says 0.76.0.** The skew
   §11 predicted is real. Phase 1 pins the daemon from npm and must verify the
   pair, not assume it.
5. Convex, better-auth and posthog-js are **in the dependency set and in the
   lazy chunk** even with Lody cloud capability-gated off, because
   `components/src/lib/index.ts` is a barrel that `markdown-renderer` reaches
   through `use-task-image`. Not removable without a vendor edit; it costs
   bundle size in the lazy chunk only.
