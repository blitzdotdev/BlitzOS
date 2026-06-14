e<!-- Background research (2026-06-12) into whether a reader/rewriting proxy could replace headless-Chromium
     screencast streaming for cross-origin `web` surfaces in server mode. Verdict: a narrow, read-only,
     null-origin-sandboxed fast-path is worth adding; it does NOT replace streaming. Streaming stays the
     default + sole path for anything authenticated/interactive/JS-driven. NOT YET IMPLEMENTED — design only. -->

# Reader-Proxy Fast-Path: Recommendation

## TL;DR

Build a reader-proxy fast-path, but only for the narrow case where it is provably safe: **unauthenticated, public, read-only article/static pages, rendered as null-origin sandboxed `srcdoc`, with no cookie/credential forwarding and a hard SSRF gate.** Everything else — anything authenticated, interactive, JS-driven, or that the agent must operate — stays on the existing headless-Chromium screencast path, which remains the default and the only path for those surfaces.

The win is real but small and specific: selectable text, instant scroll, zero per-frame CPU/screencast, and clean compositing through the sandwich for "drop a reference article on a tile." It is not a replacement for streaming and cannot become one.

## Why not the obvious version

The tempting design — fetch the page server-side, strip `X-Frame-Options`/CSP, and re-serve it same-origin so it mounts in a normal `<iframe src>` — is the one design we must not ship. Re-serving cross-origin content on the BlitzOS origin collapses the same-origin boundary:

- A proxied page runs in BlitzOS's own origin. It can read `document.cookie`, `localStorage`/IndexedDB, and reach `window.parent`/`window.top` to touch the renderer DOM and the `window.agentOS` / `blitz` bridge. The widget bridge authenticates senders by frame **identity** (`event.source === iframe.contentWindow`) on the assumption that the frame's origin is the unusable `null` of a sandbox. A same-origin proxied frame defeats that assumption and can drive `serveTool`/`serveData`/`widgetRequest`. Every cross-origin site becomes stored XSS plus OS-control escalation.
- "Just sandbox it" does not save this design. The existing `app` surface iframe uses `allow-scripts` + `allow-same-origin` **together**. Once a framed document is same-origin (which the proxy makes it), script in that frame can reach the parent, delete the `sandbox` attribute, and reload itself fully unsandboxed. The sandbox is not a boundary in that combination.
- Stripping XFO/CSP/SRI also strips the **victim page's own** XSS and supply-chain defenses at the exact moment its code is executing inside our trusted origin.

So the header-stripping, same-origin, cookie-forwarding variant is off the table on principle, not on polish.

## What's actually solvable

The static-rewrite problem (rewrite `href`/`src`/`srcset`/`<form action>`/`<link>`/`<base>`, plus `url()`/`@import` inside fetched CSS) is reliable **only** for content-static pages. Any JS-driven page builds URLs at runtime (`fetch`/XHR/dynamic import/`new Image().src`) that never appear in the static HTML, so they either fail or leak straight back to the origin. The state of the art (pywb) only makes live clones work by also injecting a client-side shim (wombat.js) that monkey-patches a dozen browser APIs — and the experts who maintain it treat that as perpetually leaky, best-effort. We are not building that. We accept "static content only, JS-driven pages degrade" as a hard scope line, not a bug to fix later.

Two facts make the narrow case tractable for us specifically:

1. We don't need to run the page's JS to get useful content. For the freeze-an-article case we can serve sanitized, neutered HTML (reader extraction: strip `<script>`, inline handlers, `<iframe>`/`<object>`, `javascript:` URLs) — a reader **extracts** content, it does not run the page.
2. If we ever want the post-JS DOM, BlitzOS already has the headless engine to render-then-serialize (drive a host target, let it settle, `Runtime.evaluate('document.documentElement.outerHTML')`). That pays a render but yields a same-origin static snapshot. We note this as an available middle path but do **not** include it in the initial scope — it erases the "cheap fetch" saving and adds the perception/control gaps below.

## The control/perception cost (why this is read-only)

A proxied surface has no host CDP target, so:

- `surface_control` (click/type) cannot work — there is no headless engine behind it.
- The perception loop emits **no moments** for a proxied surface; the agent goes blind to it.
- `read_window` is the one recoverable signal — we already have the HTML server-side and can re-fetch/serialize on demand.

Conclusion: proxy surfaces are **read-only, no-control, limited-perception**. The routing heuristic must send "the agent needs to act here" to streaming, always.

## What we'd build

A flag on the existing `kind: 'web'` surface, not a new sub-kind:

- `surface.props.render = 'proxy' | 'stream'`, default `'stream'` in server mode. Keeping the same `kind` means `list_state`, `account_hint`, move/close, cross-workspace addressing, and the persisted `.weblink` shape all keep working untouched. A new sub-kind would force edits to every `kind` switch for no gain.
- `reconcileSurfaces` learns one new behavior: **skip** `host.createSurface` for `render === 'proxy'` surfaces (no headless target needed). That is the only server-side change beyond the route.
- Render path in `SurfaceFrame`: `serverMode && props.render === 'proxy'` → mount sanitized content via **`srcdoc`** (BlitzOS's existing `srcdoc` kind) with `sandbox='allow-scripts'` and **without** `allow-same-origin` (origin becomes `null`; cannot touch BlitzOS cookies/DOM/bridge) — ideally with no `allow-scripts` at all for pure reader content. Never `src=` on the BlitzOS origin. Everything else falls through to the existing `<canvas>` screencast.

The server route, with the security gates as the load-bearing part:

- `GET /api/os/proxy` (or fold into the existing file route). **SSRF-gate first**: http/https only; resolve hostname → IP at fetch time and **pin** that IP for the connection; reject loopback/RFC1918/link-local/IMDS (`169.254.169.254`, `127/8`, `10/8`, `172.16/12`, `192.168/16`, `::1`, `.internal`); re-validate on **every** redirect hop (fetch with `redirect: 'manual'`); cap size and time. This defends against octal/hex/decimal IP encodings, IPv6 forms, redirect-to-internal, and DNS rebinding. The gate is non-negotiable — the local control server on `127.0.0.1` mints a bearer token, so an SSRF that reaches it is OS-control escalation.
- **Server-minted / signed proxy URLs only.** The server mints the proxy URL for surfaces it created; the route does not accept arbitrary caller-supplied targets. This closes the open-forward-proxy hole on the public cloudflared tunnel.
- **No credentials, ever.** Upstream fetch omits cookies; drop every `Set-Cookie` and auth header from the response. Nothing a third-party site does can write to our origin cookie jar.
- **Sanitize, don't pass through.** Strip `<script>`/handlers/`javascript:`/`<iframe>`/`<object>`; serve body content only. Apply our **own** tight CSP (e.g. `connect-src` locked) so the page can't reach `/api/*` even if something slips through — which also conveniently neutralizes the runtime fetches we couldn't rewrite.
- Given the bearer-less, `sameSiteOnly()`-only posture on a public tunnel, **gate the proxy route behind a bearer even in the prototype.** It is strictly more dangerous than the read-only, jailed `/api/os/file`.

Routing: on open, probe the URL server-side and choose. Proxy-eligible = 200, `text/html`, no auth/session indicators, content-static heuristic (low script density / article schema / known reader-friendly host). Force-stream = any login wall (401/403, redirect to `/login`/`accounts.*`, password input), WebSocket/EventSource, empty-body SPA shell, or a URL matching a connected integration's web host (`account_hint` hit → it's a logged-in surface). Make it runtime-detectable: if a proxied `srcdoc` loads blank or errors, **auto-fall-back** by flipping `props.render = 'stream'` and reconciling (which spins up the headless target). Never silently strand a surface.

## Non-goals (explicit)

- **No authenticated or cookie-bearing proxying.** The proxy never forwards the user's cookies or `Authorization`, never carries an OAuth/SSO flow (redirect_uri is registered to the real origin; `SameSite` cookies won't ride the proxied context anyway), and never lets a target set cookies on our origin. Logged-in surfaces are streaming-only.
- **No same-origin re-serving.** Proxied content is never served via `src=` on the BlitzOS origin and never combines `allow-scripts` with `allow-same-origin`. Null-origin `srcdoc` or nothing.
- **No live interactivity through the proxy.** No `surface_control`, no click/type, no SPA "use the app." Interactive == stream.
- **No attempt to make JS-driven pages work via rewriting.** No wombat-style client shim, no runtime API hijacking. JS-driven pages degrade and route to stream; we do not chase the leaky 95%.
- **No general-purpose forward proxy.** Only server-minted URLs for surfaces BlitzOS created; no arbitrary `?url=` from callers.
- **No crawler impersonation / paywall bypass.** Clean desktop UA only (reuse the host's `cleanUA`); we do not impersonate Googlebot or fetch cached copies.
- **Streaming is not being replaced or deprecated.** It remains the default in server mode and the sole path for everything outside the narrow static-read case.

## Bottom line

Add the fast-path, scoped to unauthenticated public static/article reads, rendered null-origin `srcdoc`, no cookies, SSRF-pinned, bearer-gated, with automatic fall-back to streaming. It buys a genuinely nicer "reference article on a tile" experience at low ongoing cost. It does not, and should not try to, cover the cases BlitzOS exists for — those stay on the screencast, which is the only design that keeps foreign code out of our origin: pixels in, events out.
