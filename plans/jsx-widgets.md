# Plan: JSX widgets with a curated CDN React runtime (rev 4 — re-verified at HEAD 8899099: codex-backend + inbox-reconcile + spatial-UI merge touches NO widget-path file)

## Context

A BlitzOS widget is a single `.html` string rendered as `<iframe sandbox="allow-scripts">` with
`srcDoc = BRIDGE_SHIM + UI_KIT + (surface.html ?? '')` (`src/renderer/src/components/SurfaceFrame.tsx:787-802`).
No bundler, no imports. We want agents to author widgets **on the fly at runtime** in **JSX**,
`import` React + a curated set of common libraries, rendering live in the same sandbox — no
build server, no deploy.

Re-verified at HEAD (88 commits after the first draft): srcdoc surfaces are still ordinary DOM
iframes in the L1 "sandwich" window (only `kind:'web'` moved to main-owned WebContentsViews);
**no CSP exists anywhere** (esm.sh imports work); **no JSX/compile work has landed** — green-field.

Locked decisions:
- **JSX default** (`lang:'jsx'`, `.jsx` files); TSX opt-in (`lang:'tsx'` adds the TS-strip transform).
- **Compile in-browser at mount** (Sucrase strip-only; no type-check, no deploy).
- **Libs direct from pinned esm.sh via a static import map** + `immutable` HTTP caching. No
  vendoring/proxy/Service Worker/scheme in P1 (SW-offline = P4; requires host-origin routing
  because an opaque-origin iframe can't be SW-controlled).
- **Single-file** widget now; multi-file = P3 (esbuild-wasm over a virtual FS).
- **Bridge & UI stay global** — `window.blitz` + `<blitz-*>` work as-is in JSX. No `@blitz/os`/`@blitz/ui`
  wrapper modules (a second API surface would drift from the real bridge — the exact drift this
  codebase already unified away).

## Architecture — mount-time pipeline

When `surface.kind==='srcdoc' && surface.lang && surface.lang!=='html'` (shared `SurfaceFrame`,
so Electron + browser preview are parity-correct by construction):

1. **Compile** — new `src/renderer/src/widget-jsx.ts`: Sucrase
   `transform(src, { transforms: lang==='tsx' ? ['typescript','jsx'] : ['jsx'], jsxRuntime:'automatic', production:true })`.
   Sucrase is **lazy-imported and the compile is async** → the srcdoc branch renders a plain
   **div shell** (NOT an iframe) until it resolves — mounting the iframe only once avoids a
   double document load / double `blitz:init` handshake. Results (including **errors**) live in a
   **bounded module-level cache keyed by source hash** so reloads/remounts are instant and bad
   source isn't recompiled per render. Bare imports left intact. Syntax error → error-card
   srcdoc + agent-readable error (below).
2. **Compose** — `BRIDGE_SHIM + UI_KIT + IMPORT_MAP + BOOTSTRAP + <script type="text/blitz-jsx">{compiledJs}</script>`
   - **Escape the embedded payload**: compiled JS containing `</script` (e.g. in a string literal)
     would terminate the carrier tag and shatter the document — escape as `<\/script` (or base64)
     when embedding; the bootstrap decodes before blob-ifying.
   - `IMPORT_MAP`: static `<script type="importmap">` from the manifest. Identical in both transports.
   - `BOOTSTRAP` (`<script type="module">`): **creates and appends `<div id="root">`** (nothing
     else creates it), reads the inert compiled source, makes an **in-iframe blob-URL module**
     (blob inherits the iframe's origin → importable; bare imports resolve via the import map),
     `import()`s it, mounts `createRoot(root).render(createElement(mod.default))`. Catches runtime
     errors → overlay + agent-readable error.
   - The branch swaps **only the srcDoc string** — the existing iframe effects stay intact:
     `onLoad`/`blitz:hello` → `blitz:init` with `widgetProps()` (OS-accent + `accentInk` folding,
     `SurfaceFrame.tsx:158-164`), live `blitz:props` re-post on props/accent change
     (`SurfaceFrame.tsx:510-514`), the bridge `onMessage` ops (`data/tool/msg/chat/listdir/setprops`
     + `blitz:contextmenu`/`blitz:annotation`), `postRes` generation-pinning, the focus catcher.
3. **Libs** — import map → pinned esm.sh URLs; browser/Electron net stack HTTP-caches the
   `immutable` bytes. "Fast after first load" with no new code.

**Agent-readable errors:** compile + runtime errors are folded into the surface's props as
`props.lastError` via the existing `updateSurfaceProps`/`setprops` path, so the agent reads them
from `list_state` (the documented confirm-a-drive pattern in `blitzos-agents.md:118`). The visual
error card is for the human; `lastError` is for the agent. Cleared on next successful mount.

## Registry

`widgets/runtime/registry.json` → `{ specifier: "https://esm.sh/..." }`, one line per lib.
**Pin react@19** — React 19 has first-class custom-element support (properties + events), which
`<blitz-input onSend>` / `<blitz-row onOpen>` need. Use **`?external=react,react-dom`** on every
non-react lib so its `react` import resolves through the iframe's import map to the ONE pinned
instance (cleaner single-React guarantee than `?deps`). Include the `react/jsx-runtime` subpath
(Sucrase automatic runtime emits it).

| Specifier | Why |
|---|---|
| `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime` (v19, pinned) | core + automatic JSX runtime |
| `clsx` | class composition |
| `lucide-react` | icons (chosen) |
| `recharts` | charts/dashboards (react-19-compatible version) |
| `date-fns` | dates/time |
| `framer-motion` | animation/gestures |
| `react-markdown` + `remark-gfm` | markdown / agent-output panels |

## Bridge & UI in JSX

`window.blitz` is injected before author code; `<blitz-*>` elements are registered by `UI_KIT`.
Document the React patterns in the authoring doc (incl. the ref+addEventListener fallback for
custom events if a lib pins react 18). Mount convention: `export default` a component; the
bootstrap mounts it. Example:

```jsx
import { useState, useEffect } from 'react'
export default function Clock() {
  const [p, setP] = useState(blitz.props())
  const [now, setNow] = useState(new Date())
  useEffect(() => blitz.onProps(setP), [])
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id) }, [])
  const toggle = () => { const f = p.format === '24h' ? '12h' : '24h'; setP({ ...p, format: f }); blitz.setProps({ format: f }) }
  return <blitz-button onClick={toggle}>{now.toLocaleTimeString(undefined, { hour12: p.format !== '24h' })}</blitz-button>
}
```

## File-by-file

**Renderer**
- `src/renderer/src/types.ts` — `lang?: 'html' | 'jsx' | 'tsx'` on `Surface`, next to `html` (types.ts:43-47). No name collision (verified).
- `src/renderer/src/widget-jsx.ts` *(new)* — async Sucrase compile + bounded hash cache + import-map/bootstrap composer + error card + `lastError` reporting.
- `src/renderer/src/components/SurfaceFrame.tsx` — srcdoc branch: when `lang` is jsx/tsx, srcDoc comes from `widget-jsx` (placeholder while compiling). Everything else (onLoad, bridge handler, props effects) unchanged.
- `src/renderer/src/components/SurfacePreview.tsx:58` — **gap found in review**: previews render raw `surface.html` (no shim/kit); for jsx surfaces reuse the compiled composition from the cache, else show a code-placeholder tile (never raw JSX-as-HTML).

**Persistence (workspace.mjs — NOT workspace-host.mjs; without this a jsx widget breaks on restart)**
- `CONTENT_EXTS` (workspace.mjs:93) += `.jsx`, `.tsx`.
- `contentFor` (workspace.mjs:126, srcdoc case :145) — pick `ext` from `s.lang` (`jsx`/`tsx`/`html`); body stays `String(s.html)` (the `html` field stays the source-of-truth name for all langs — renaming it would churn every persistence/merge path for no gain).
- `autoKind` (workspace.mjs:743) — `.jsx`/`.tsx` → `'srcdoc'` (they currently fall through to passive file tiles).
- `nodeToSurface` (workspace.mjs:702) — set `lang` from the content-file extension on hydrate.

**Tools / catalog / docs (all single shared files — no parity seam; both transports spread create args: `backend.mjs:566` `{...a,id}`, `osActions.ts:617` `{...desc,id}` — verified)**
- `src/main/os-tools.mjs` — add `lang` to `create_surface` (:219-223) + `update_surface` (:356) schemas; `spawn_widget` (:538) propagates `lang` from the catalog entry; `save_widget` (:564) schema += `lang`; `serializeStateForAgent` exposes `lang` and `props.lastError`.
- `src/main/widget-catalog.mjs` — `saveWidget` stores `<name>.jsx` when `lang:'jsx'` + manifest entry gains `lang`; `getWidgetSource` resolves the extension from the manifest; add `WIDGET_AUTHORING_JSX_MD` (registry list generated from the manifest; React patterns over global `window.blitz` + `<blitz-*>`; `export default` mount; `lastError` confirm pattern; **when to choose jsx vs html** — jsx for stateful/data-heavy widgets, plain html stays right for trivial static ones).
- **Doctrine rewrite (deliberate):** `WIDGET_AUTHORING_MD` "fetch()/XHR DO NOT WORK… inline everything" (:210-216) and `blitzos-agents.md` "srcdoc has NO network" (:31, :61) are over-claims that JSX imports make *visibly* false. Replace with the real rules: **tokens never enter a widget; integration data ONLY via the bridge; libraries ONLY from the curated registry; no other external scripts.** Do not cite the provider approval card (removed — `provider-call.mjs:163-165`; only the scope pre-flight remains).
- `package.json` — add `sucrase` (and `es-module-lexer` only if the fallback below is needed).

## Phasing

- **P1** — `lang` end-to-end: types, widget-jsx compile/compose, SurfaceFrame branch, SurfacePreview fix, workspace.mjs persistence quartet, registry.json (react19 + clsx + lucide-react), os-tools/catalog `lang`, doctrine rewrite, `lastError`. One clock widget verified end-to-end.
- **P2** — rest of the registry (recharts/date-fns/framer-motion/react-markdown), authoring-doc polish, `list_widgets` lang surfacing.
- **P3** — multi-file widgets (esbuild-wasm, virtual FS).
- **P4 (only if needed)** — SW/host-proxy offline caching; widget CSP restricting imports to the registry; at-save precompile.

When implementation starts, copy this plan to `packages/BlitzOS/plans/jsx-widgets.md` (repo convention).

## Verification

- **Smoke the load-bearing assumption FIRST** (before any wiring): a static srcdoc fixture with importmap + blob-module + esm.sh react — confirm bare specifiers in a blob module resolve via the document import map inside `sandbox="allow-scripts"`. If it fails: fallback = rewrite bare specifiers to registry URLs at compile time with `es-module-lexer` over the Sucrase output (precise, not regex), which removes the import map entirely.
- **Compile unit** — `scripts/test-widget-jsx.mjs`: golden JSX→JS; TSX mode; syntax error → error result.
- **End-to-end** — control API: `create_surface {kind:'srcdoc', lang:'jsx', html:<clock>, props:{format:'12h'}}` → `list_state` shows it (with `lang`); `bash scripts/screenshot.sh <preview-url>` confirms render; click toggles format (props round-trip).
- **Restart survival** — create jsx widget → restart preview → widget rehydrates with `lang:'jsx'` from the `.jsx` file and renders (the persistence quartet).
- **Error path** — bad JSX → error card renders AND `list_state` shows `props.lastError`.
- **Security regression** — jsx widget still can't reach `window.parent`/`localStorage`/non-allowlisted tools; previews never execute raw JSX as HTML.
- **Cache** — second mount: no new esm.sh hits (HTTP cache).
- `npm run check` green (typecheck + parity + build).

## Risks

- **Blob-module × import-map interplay** — the one unproven assumption; smoke-tested first, named fallback ready (above).
- **react@19 lib compat** — verify recharts/framer-motion react-19 versions on esm.sh before pinning the registry.
- **No CSP today** — the registry curates the happy path but can't prevent a widget importing an arbitrary URL (same posture as today's html widgets). Hard restriction = P4 CSP.
- **CSP inheritance footgun** — srcdoc iframes INHERIT the embedding document's CSP. If the renderer ever adds one (standard Electron hardening), every registry import silently breaks unless `script-src` allows the registry origin. Note this where a renderer CSP would be added; ties into the P4 widget-CSP work.
- **esm.sh availability on cold first load** — accepted for P1; SW-offline is P4.
