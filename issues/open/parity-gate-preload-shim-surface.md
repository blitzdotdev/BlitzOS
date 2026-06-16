# Parity gate misses preload↔server-shim API divergence (caused a blank preview)

**Severity:** real (caused agentos.blitzmen.com to render BLANK after the spatial-UI merge).
**Found:** 2026-06-16, while merging the spatial-UI batch.

## What happened

`scripts/check-parity.mjs` enforces that the shared `.mjs` runtime cores are imported by BOTH
transports — but it does NOT check the `window.agentOS` API surface (Electron `src/preload/index.ts`
vs the browser shim `preview/agentos-shim.js`). The spatial-UI merge + onboarding work added ~26
preload methods (`onShiftTap`, `onKeybind`, `onRadialKey`, `onShellFullScreen`, `onWebTab`,
`onPageCursor`, `nativeInput`, `webGeometry`, the `webContentsView*` family,
`pageInput`/`pageFocus`/`uiFocus`/`shellDrag`, `decidePermission`, `requestHydrate`, `agentRuntime*`,
`bookmarks*`, the whole `onboarding.*` namespace, …) WITHOUT adding them to the shim. The renderer
calls several at mount as `window.agentOS?.onShiftTap(cb)` — the `?.` guards `agentOS`, not the
method — so a missing method threw in a mount effect, React aborted the commit, and the whole app
went blank. Patched in `c1457c8` (added the 26 methods to the shim; gated native onboarding off in
server mode).

## The gap to close

Add a parity check (extend `scripts/check-parity.mjs` or a new test) that asserts **every key the
renderer reads off `window.agentOS` exists in BOTH `src/preload/index.ts` and
`preview/agentos-shim.js`**. Sketch:
- Extract the set of `window.agentOS?.<name>` / `agentOS.<name>` identifiers the renderer references
  (grep `src/renderer/`), plus aliased namespaces (`const api = window.agentOS?.onboarding` →
  `api.<name>`).
- Assert each name is defined in the preload object AND the shim object.
- Fail the build on a name present in one but not the other (the exact divergence that blanked the
  preview).

This makes the preload/shim API a first-class parity surface, not just the `.mjs` cores — so a new
preload method can't silently break server mode again.

## Note

Server mode is intentionally degraded for some of these (sandwich input forwarding, native
per-tab WebContentsView, native onboarding) — the shim no-ops them. The check should assert
*presence* (no missing key → no crash), not behavioral equivalence.
