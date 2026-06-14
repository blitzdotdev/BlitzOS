# BlitzOS Visual Design System — "Spatial-grade"

**Status:** Foundation artifact (design tokens landed at `src/renderer/src/tokens.css`; not yet wired into the live app). The source of truth for the BlitzOS *look*. All redesign work references this.
**Source:** A deep teardown of **Spatial.app** (`com.44x.spatial`, native Swift/AppKit, by Tobias Renström / 44x; icons by Andreas Storm) — bundle RE (Core Data model, binary strings, leaked source tree, asset catalog) + exact color sampling from live screenshots. Reference shots: `design/spatial-reference/` (local, gitignored).
**Scope (locked with the user):** Make BlitzOS **look like Spatial** — adopt its **visual design system** + the **focus-flow motion only**. Inherit **nothing else yet**: no gravity auto-layout, stacks, rotation, folders-as-subcanvases, the Popper creation model, or its conceptual data model. **Dark theme first** (light deferred).

---

## 1. North star — one principle

**A dark, calm "void"; chrome recedes; colored paper and media pop.** Everything on screen is low-contrast dark *except the content*. Generous negative space, editorial restraint, soft tactile materials, a deliberately **muted** palette (no saturated primaries). If BlitzOS adopts one thing, it's this posture — the opposite of the current GitHub-neon-on-blue-black chrome.

The feeling Spatial chases (seeded verbatim in its own demo): *"elegant, enjoyable and distinct."*

---

## 2. The reference, in one paragraph

Spatial is a native infinite-canvas workspace: a near-black canvas holds sparse, rounded "paper" objects (stickies, notes, web-clips, images, video) floating in lots of space. Chrome is two low-contrast pill clusters in the bottom corners (settings left; space-pager + bookmark + `+` right) and a floating scratch-pad HUD (⌥Space). Opening an item runs an **eased zoom-transition** into a focused view (back-button leash, color palette, mono metadata, action toolbar) over a dimmed canvas. Type is editorial (a neo-grotesk for UI, a serif for long-form, mono for metadata). It is buttery (CALayer-backed, dedicated animators) and restrained.

---

## 3. Tokens (canonical — mirrors `tokens.css`)

### 3.1 Neutral ramp (exact, sampled)
A cool-charcoal ramp — not blue-black, not teal.

| Token | Hex | Role |
|---|---|---|
| `--canvas` | `#1D2023` | desktop void (darkest) |
| `--surface` | `#2C3033` | panels, popovers, toolbars, window chrome |
| `--surface-raised` | `#34373C` | hovered rows, nested panels |
| `--control` | `#424445` | pill/button rest |
| `--control-hover` | `#4C4F51` | pill/button hover |
| `--control-active` | `#5A5C60` | pressed |
| `--divider` | `#3A3D41` | 1px dividers |
| `--text` | `#F9FAFB` | primary text |
| `--text-secondary` | `#C8CACB` | icon glyphs, secondary |
| `--text-muted` | `#8E9192` | labels, captions |
| `--text-tertiary` | `#5F6364` | placeholder, disabled |

### 3.2 Accents — warm signature + **restrained** semantics
Spatial is muted/editorial; semantics are desaturated, **not** neon.

> **Accent is live as Blitz red `#e31c30`** (tokens.css, picked 2026-06-11; coral below was the original spec, since superseded). The primary is **not fixed** — treat `--accent`/`--accent-deep` as the source of truth and never hardcode a hex for it. All accent-bearing UI (onboarding preboard/boot/unlock cards, chrome, widget kit `--blitz-accent`) reads the token so a future primary swap is one place.

| Token | Hex | Role |
|---|---|---|
| `--accent` | `#e31c30` | signature primary (Blitz red today; coral `#FF8D61` was the original spec) |
| `--accent-deep` | `#ad1422` | pressed/hover (was terracotta `#924B2F`) |
| `--marker` | `#FFE92E` | text-highlight yellow (ink stays dark) |
| `--positive` | `#7FA98C` | muted sage (replaces GitHub `#3fb950`) |
| `--danger` | `#E0786E` | muted coral-red (replaces `#f85149`) |
| `--info` | `#7FA0C8` | dusty blue (replaces `#58a6ff`) |

### 3.3 Paper palette — item / native-note colors
Seven muted tones + the bright coral tint (sampled from the focus-view swatch column). **No saturated primaries.** Each has a paired legible `*-ink`.

`--paper-ink #0D0D0D` · `--paper-mauve #493839` · `--paper-terracotta #924B2F` · `--paper-coral #FF8D61` (hero) · `--paper-tan #A78B6A` · `--paper-bone #D1CEC2` · `--paper-blue-dust #7FA0C8` · `--paper-blue-slate #5B78AA`

### 3.4 Material, geometry, motion (summary; full values in `tokens.css`)
- **Frosted dark glass** (`.material-glass`): `surface @82%` + `blur(20px) saturate(1.2)` + top-edge inner highlight + hairline + `--shadow-md`. Apply to all chrome.
- **Scrim** `--scrim rgba(12,13,14,.55)` dims the canvas behind popovers and focus.
- **Radii**: button `12` · control `10` · pill `999` · panel `16` · window `14` · **card/paper `22`** (large, soft).
- **Shadows**: `--shadow-sm/md/lg`.
- **Motion**: `--ease-out` (expo-out) for the focus zoom; `--dur-zoom 520ms`; quick `--dur-fast/base` for chrome.

---

## 4. Typography & licensing (honest)

Spatial ships commercial faces (Unica77 LL, Eina03) we **cannot** redistribute. Substitutes that hold the character:

| Role | Spatial | BlitzOS (free/native) | Notes |
|---|---|---|---|
| UI grotesque | Unica77 LL | **SF Pro** (`-apple-system`, native on macOS) → fallback **Geist**/**Inter** | `--font-ui` |
| Serif (long-form/notes) | Volkhov | **Volkhov** — it's OFL/free, **bundle it** | `--font-serif`; the editorial soul |
| Mono (metadata/counters) | (a mono) | **SF Mono** (`ui-monospace`, native) → **Geist Mono** | `--font-mono`; UPPERCASE + `--track-label` for labels |

**Volkhov bundling:** add the OFL `.woff2` under `src/renderer/src/assets/fonts/` + an `@font-face`. Eina is dropped (the grotesk covers it). SF Pro/SF Mono are free on the target (macOS Electron) via the system stack — zero bundle cost.

---

## 5. Shape & material details

- **Continuous-corner squircles.** Spatial's buttons use iOS-style continuous corners. CSS `border-radius` is a plain arc; the large radii in §3.4 approximate it well enough for chrome. For the **hero paper objects** (native notes, focused surface) where the silhouette matters, use a true squircle via an SVG/`paint()` corner-mask — tracked as a §10 D2 task, not a launch blocker.
- **The button material** is the tell: never a flat fill. Always `--control` + the top-edge inner highlight (`inset 0 1px 0 --edge-highlight`) + hairline. That faint top light is what makes them read as soft physical buttons.
- **Recede, don't disappear.** Chrome sits at `--control` on `--canvas` — visible but quiet. Color is reserved for content.

---

## 6. Components → BlitzOS surfaces

Each maps onto a real BlitzOS file (`src/renderer/src/...`).

- **Titlebar / Sidebar / Toolbar** (`App.tsx`, `styles.css .titlebar/.sidebar/.toolbar`, `Sidebar.tsx`) → `.material-glass`, mono labels, squircle `--radius-button` icon buttons at `--control`. Lower contrast; remove borders in favor of hairline + edge-highlight.
- **Surface frame** — web/app/srcdoc/native (`SurfaceFrame.tsx`, `.window`) → each surface is a **paper object on the void**: `--radius-window`, `--shadow-md`, hairline; selected state gets a soft `--accent` ring (the leash/affordance). Web-content body stays as-is (it's third-party).
- **Native note / post-it** (`NoteWidget.tsx`, `.window.note/.note-text`) → `--radius-card`, a **paper palette** background (default `--paper-coral`) with its `--paper-*-ink` text, body in `--font-serif` (the editorial move). Replaces the current single-yellow `#3a2f00` note.
- **Pills / buttons / dropdowns / segmented key-chord** → stadium `--radius-pill` for counters/segmented; `--radius-control` dropdowns with a muted chevron; key-chord pickers render modifier glyphs (⌘⌥⇧⏎) like Spatial's Settings.
- **Popover** (spaces-style list; new) → `.material-glass` panel, rows = icon + label + right-aligned mono `⌘`-shortcut; **scrim** behind. Reuse for any BlitzOS list/menu.
- **Floating action toolbar** (new; for focused surface) → `.material-glass` pill, evenly-spaced line icons.
- **Scratch-pad HUD** → this is the natural skin for the **"Connect AI" panel** (`.ai-panel`) and any future command HUD: centered floating `.material-glass` bar, input + send + `⌘⏎` chip.
- **Metadata block** (new; focused view) → mono UPPERCASE label / value pairs at `--text-muted`.

---

## 7. Motion — the focus flow *(the one borrowed feel)*

The only thing inherited from Spatial's *interaction* layer. It also happens to be BlitzOS's already-planned **follow-mode / attention** seam — so this borrow does double duty.

**Spec:** selecting/opening a surface → an **eased zoom-transition** (`--ease-out`, `--dur-zoom`) centers it; the rest of the canvas **scrim-dims**; a **back-button** (top-left circle) is the visible leash home (⌘0 / Esc). Around the focused surface: optional left palette (for native notes), right mono metadata, bottom action toolbar.

**Wiring (BlitzOS):** `store.focusAndZoom` already computes the center+fit transform (`store.ts`) but is **unreachable** — no `os:action` maps to it (per the architecture doc, pillar 8). The redesign adds a `focus` os:action case in `App.tsx` dispatch driving `focusAndZoom` with the eased tween + scrim + back-button. This stays **visual/navigational** — it does not pull in any other Spatial interaction (no gravity, no stacks).

---

## 8. Migration map — current `styles.css` → tokens

The current theme is GitHub-dark + neon. The swaps:

| Current | → New token | Note |
|---|---|---|
| `--bg #0e1116` | `--canvas #1D2023` | warmer, less blue |
| `--ink #e6edf3` | `--text #F9FAFB` | |
| `--muted #8b949e` | `--text-muted #8E9192` | |
| `--panel #161b22` | `--surface #2C3033` | |
| `--line #30363d` | `--divider #3A3D41` (+ `--hairline`) | prefer hairline+edge-highlight |
| `--grid rgba(..,.04)` | `transparent` | **remove the dot grid** — clean void |
| `#1f6feb` / `#58a6ff` (action/link) | `--accent` / `--info` | coral primary, dusty-blue links |
| `#f85149` (danger) | `--danger #E0786E` | de-neon |
| `#3fb950` (connected dot) | `--positive #7FA98C` | de-neon |
| `#1b222c`,`#21262d`,`#2c333d`,`#1a1f27`,`#262d38` (hardcoded) | `--surface` / `--control` / `--control-hover` / `--surface-raised` | kill scattered hexes |
| inputs `#0e1116` | `--canvas` | |
| window radius `10` / widget `12` / note (yellow) | `--radius-window 14` / `--radius-card 22` | larger, softer |
| system font | `--font-ui` (+ `--font-serif` for notes, `--font-mono` for labels) | |
| note ink `#3a2f00` on yellow | `--paper-coral` + `--paper-coral-ink`, serif body | |
| `.titlebar/.toolbar/.sidebar/.ai-panel` blur | `.material-glass` | one material recipe |
| primary-space dashed blue | `--accent` dashed (subtle) | |

---

## 9. Deliberately deferred (NOT in this redesign)

Gravity/flow auto-layout · stacks/piles · item rotation · folders-as-zoomable-subcanvases · the Popper radial create menu · the conceptual data model (rotatable/positioned item entities) · light theme · bundling Spatial's actual icon set (we use our own line icons in the same style). These are interaction/conceptual, not visual — out of scope until the visual system + focus-flow ship and prove out.

---

## 10. Build sequence (visual-only; no behavior change except focus-flow)

- **D0 — Tokens** ✅ `tokens.css` (this artifact).
- **D1 — Wire + chrome recede** ✅ LANDED: `tokens.css` imported in `main.tsx`; `styles.css` fully migrated to tokens (no raw hexes); frosted-glass titlebar/sidebar/toolbar/HUD/panels; dot grid removed; `--font-ui`/`--font-mono` wired; **Volkhov bundled** (`assets/fonts/Volkhov-{400,700}.woff2`, OFL). Build + typecheck pass.
- **D2 — Surfaces as paper** ✅ LANDED: line-icon set (`components/Icons.tsx`) replaces all emoji in `SurfaceFrame`/`Sidebar`/toolbar; `.window` token material + `:focus-within` accent ring; native note → **paper palette** (`NOTE_PAPER`, coral default) + serif body; `Chat`/`Activity` panels + consent overlay token-ized. *(Selection ring is `:focus-within` for now; explicit selection lands with D4.)*
- **D3 — Components** ✅ LANDED: reusable kit (`.btn`/`.pill`/`.popover`/`.icon-btn`) in `styles.css`; frosted toolbar cluster with icons; "Connect AI" reskinned as the `.hud` (scratch-pad-style bar). *(Spaces-popover + floating action toolbar classes exist, wired for D4.)*
- **D4 — Focus flow:** `focus` os:action → `focusAndZoom` eased tween + scrim-dim + back-button leash; focused-surface chrome (metadata/toolbar). **← next**

Each phase is independently shippable and visual-only. **Next step after this artifact: audit the current renderer against §6/§8 and start D1.**
