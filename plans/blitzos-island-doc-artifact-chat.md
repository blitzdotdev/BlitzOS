# Island chat: Doc + Artifact — the simple/maintainable build

Status: RESEARCH → PLAN (2026-06-19). Decision from the 3-design pass (`HTML Chat — 3 designs`): build **Design C — a markdown document + placeable artifacts**, but the brief is explicit — *not overengineered, simple, maintainable, easily debuggable*. This doc is the minimal architecture and the migration path. Replaces the `isl-msg` bubble feed in `notch/IslandPanel.tsx`.

## The one insight: BlitzOS already IS an artifact system

We are NOT building generative UI from scratch. The repo already gives us every hard piece — Design C is ~80% reuse:

| Need | Already in the repo | So we... |
|---|---|---|
| Render markdown | `react-markdown` + `remark-gfm` (the `markdown-card.jsx` widget) | use the SAME stack in the renderer |
| Sandbox agent HTML | the srcdoc widget iframe + `blitz:req/res` bridge (`SurfaceFrame.tsx`, `useJsxWidget`) | reuse the iframe for inline artifacts |
| Place a thing anywhere on screen | `create_surface {kind, x,y,w,h}` (agents already call it) | floated artifacts = **zero new code** |
| Stream agent text into a thread | `IslandMessage[]` per session (`notch/types.ts`, App.tsx chat handler) | render that array as a doc |

The ONLY genuinely new code is: render the message text as markdown, and one small inline-artifact embed. Everything else is wiring.

## Stack decision (evidence-backed)

- **Markdown = `react-markdown` + `remark-gfm`** as real renderer deps (NOT marked+DOMPurify, NOT a custom parser).
  - Safe by default: it converts tokens to React elements (JSX escaping), never `dangerouslySetInnerHTML`, and **ignores raw HTML** — so no DOMPurify, no manual sanitize step. (HackerOne; react-markdown security note.)
  - Maintainable: it is the stack the OS already uses for widgets — one markdown story, not two. Style it with a `components` map onto the OS type scale (the `markdown-card.jsx` pattern).
  - Debuggable: output is real DOM/React elements — selectable text (solves to-do #2), inspectable in devtools, no opaque innerHTML.
- **Streaming = re-parse the whole message per token.** Agent `say()` messages are short; this is "sufficient for most chat apps" (Vercel AI SDK cookbook). If a long message ever janks, the localized upgrade is block-memoization (split on `\n\n`, `React.memo` each block so only the last re-parses) or swap in `Streamdown` — no architecture change. Do NOT add a streaming lib up front.

## The artifact model: two placements, both reuse existing infra

An "artifact" is just a **sandboxed srcdoc surface**. The only question is WHERE it lives — and that maps to a real, validated UX split (inline = "think with it"; separate = "review it").

1. **Floated artifact (on the canvas) — ZERO new code.**
   The agent calls the existing `create_surface {kind:'srcdoc'|'native', x,y,w,h}` to drop a chart / table / mini-app anywhere on the canvas. This already works. The doc renders a one-line **reference chip** ("▢ build chart →") that focuses the surface. This IS the "agents allocate space for artifacts anywhere" half of the brief — already shipped by the OS.

2. **Inline artifact (in the doc flow) — one thin component (~25 lines).**
   The agent emits a fenced block with an `artifact` info-string carrying JSON:
   ````
   ```artifact
   {"type":"srcdoc","h":160,"src":"<div style=…>…</div>"}
   ```
   ````
   In the island doc, react-markdown's `code` component override checks `className === 'language-artifact'`, `JSON.parse`s the body, and renders ONE `<iframe sandbox srcdoc=…>` (same sandbox attrs + `blitz:req` bridge as `SurfaceFrame`). **Malformed JSON → render it as a normal code block.** That graceful fallback is the whole safety + debug story: a bad artifact is visible source, never a crash, never unsandboxed HTML.

No artifact registry, no typed-component zoo, no new agent SDK. The agent's existing verbs (`say` + `create_surface`) plus a fenced text convention cover the entire brief.

## What changes in code

- `notch/IslandPanel.tsx` — replace the `messages.map(isl-msg)` block with `<MarkdownMessage text=… role=…/>`; delete the **Details** button + the **Working** status line (to-do #3).
- `notch/MarkdownMessage.tsx` (NEW, small) — `react-markdown` + `remark-gfm` + a `components` map (OS type scale) + the `language-artifact` → sandboxed-iframe override + the floated-artifact reference chip.
- `notch/island.css` — `.isl-doc` typography on `#000`; **`user-select: text`** on the feed (overrides the global `user-select:none` at `styles.css:25`, to-do #2); retire `.isl-msg / .isl-details / .isl-status`.
- `notch/NotchHost.tsx` — retract (opt+cmd) must only flip `notchState`; never reset `page`/threads and lift the composer's typed text so it survives a minimize (to-do #1).
- `package.json` — add `react-markdown`, `remark-gfm` (the two new deps; both small, both already proven in the widget runtime).

## Migration path (each phase independently shippable)

- **P0 — the 3 quick fixes:** selectable text, remove Working/Details, retract-preserves-state. (No new deps; lands live via HMR.)
- **P1 — the doc:** render messages as react-markdown against the bg. Delivers rich text + selectable. Ship.
- **P2 — floated artifacts:** agent `create_surface` + a doc reference chip. Mostly agent-side; the doc just renders the chip.
- **P3 — inline artifacts (only if wanted):** the `language-artifact` fence → one sandboxed iframe.

## Overengineering traps to avoid

- A bespoke artifact registry / typed component catalog → lean on srcdoc + `create_surface`.
- A hand-rolled markdown parser → edge-case bugs; use react-markdown.
- marked + `dangerouslySetInnerHTML` + DOMPurify → more deps, manual sanitize, harder to debug; only if you must render agent RAW html.
- A streaming-markdown lib before there is a perf problem → per-message re-parse is fine; memoize only if it janks.
- Unsandboxed inline HTML → always the sandboxed iframe with a code-block fallback.

## Debuggability checklist (the brief's hard requirement)

- Agent intent is plain text (markdown + a fenced convention) → diffable, greppable, loggable; you can read exactly what the agent "meant".
- Doc = real DOM text → devtools-inspectable, selectable, copyable.
- Inline artifact = a normal iframe; malformed → a visible code block, not an error.
- Floated artifact = a normal surface with the existing surface lifecycle/inspection.
- Each layer degrades to the one below (artifact → code block → text), so a failure is always legible.

## Sources (opened on the canvas)
- HackerOne — Secure Markdown Rendering in React (react-markdown safe-by-default vs sanitize)
- npm-compare — markdown-it vs react-markdown
- Vercel AI SDK — Markdown chatbot with memoization (streaming)
- tigerabrodi — How to build a performant AI markdown renderer
- Reverse-engineering Claude's generative UI (sandboxed iframe artifacts)
