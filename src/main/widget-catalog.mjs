// Shared, transport-agnostic widget library + integration-data registry.
//
// ONE source of truth imported by BOTH agent transports (the Electron desktop
// `agentSocket.ts` and the server-mode `preview/backend.mjs`) so the widget tools
// can never drift between them (the two tool arrays already drifted once — see the
// AGENTS_MD/OS_AGENTS_MD wording diff). Mirrors the control-core.mjs pattern: a
// plain `.mjs` impl + a `.d.mts` for the TS side.
//
// A "widget" is agent-readable, forkable HTML rendered as a sandboxed `srcdoc`
// surface. It reaches the OS (and, through it, the user's connected integrations)
// ONLY via the postMessage bridge exposed as `window.blitz` (the renderer injects
// the shim). The library is browsable (list/get source), forkable (read -> edit ->
// save), and extensible (save authored widgets back so the next agent sees them).
//
// SECURITY: the data registry is a CLOSED map of (provider,resource) -> a hardcoded
// absolute URL. No caller-supplied string ever influences the request URL, host, or
// headers — that's the SSRF/confused-deputy guard. Tokens are supplied by the caller
// (each transport reads its own store); this module never touches a token store.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callProvider } from './provider-call.mjs'
import { resourceRoute } from './provider-specs.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Resolve the widgets dir lazily so it works in every run context:
//  - server mode (backend.mjs imports this UNBUNDLED) -> import.meta is src/main, so
//    ../../widgets is the package-root widgets dir.
//  - Electron (main is bundled to out/main) -> import.meta points at out/, so the
//    entry sets BLITZ_WIDGETS_DIR to the real path before any catalog call.
function widgetsDir() {
  return process.env.BLITZ_WIDGETS_DIR || join(__dirname, '..', '..', 'widgets')
}
const builtinManifestPath = () => join(widgetsDir(), 'widgets.json')
const authoredDir = () => join(widgetsDir(), 'authored')
const authoredManifestPath = () => join(authoredDir(), 'manifest.json')

// Safe widget name = filename-safe slug (no slashes/dots/traversal).
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}$/

function readManifest(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function manifestEntries() {
  const builtin = readManifest(builtinManifestPath()).map((w) => ({ ...w, origin: 'builtin' }))
  const authored = readManifest(authoredManifestPath()).map((w) => ({ ...w, origin: 'authored' }))
  // Authored shadows builtin of the same name (a fork can supersede its source).
  const byName = new Map()
  for (const w of builtin) byName.set(w.name, w)
  for (const w of authored) byName.set(w.name, w)
  return byName
}

/** List the library: metadata only (never the html). [{name,description,needs,props,version,origin,forkedFrom?}] */
export function listWidgets() {
  return [...manifestEntries().values()].map((w) => ({
    name: w.name,
    description: w.description || '',
    needs: Array.isArray(w.needs) ? w.needs : [],
    props: w.props || {},
    version: w.version || 1,
    origin: w.origin,
    ...(w.forkedFrom ? { forkedFrom: w.forkedFrom } : {})
  }))
}

/** Byte-exact, transform-free, forkable source for one widget, or null if unknown. */
export function getWidgetSource(name) {
  const entry = manifestEntries().get(name)
  if (!entry) return null
  const dir = entry.origin === 'authored' ? authoredDir() : widgetsDir()
  let html
  try {
    html = readFileSync(join(dir, `${name}.html`), 'utf8')
  } catch {
    return null
  }
  return {
    name,
    html,
    description: entry.description || '',
    needs: Array.isArray(entry.needs) ? entry.needs : [],
    props: entry.props || {},
    version: entry.version || 1,
    origin: entry.origin,
    ...(entry.forkedFrom ? { forkedFrom: entry.forkedFrom } : {})
  }
}

/**
 * Save an authored widget back into the library (so it's browsable by the next
 * agent). Authored widgets live under widgets/authored/ (gitignored runtime
 * artifacts), separate from the tracked builtin library. Re-saving the same name
 * bumps version. Throws on a bad name / empty html.
 */
export function saveWidget({ name, html, description = '', needs = [], props = {}, forkedFrom } = {}) {
  if (!NAME_RE.test(name || '')) {
    throw new Error('invalid widget name (use a-z, 0-9, "-"; 2–49 chars)')
  }
  if (typeof html !== 'string' || !html.trim()) throw new Error('html (the widget source) is required')
  mkdirSync(authoredDir(), { recursive: true })
  writeFileSync(join(authoredDir(), `${name}.html`), html)
  const man = readManifest(authoredManifestPath())
  const prev = man.find((w) => w.name === name)
  const entry = {
    name,
    description: String(description || ''),
    needs: Array.isArray(needs) ? needs : [],
    props: props && typeof props === 'object' ? props : {},
    version: (prev?.version || 0) + 1,
    forkedFrom: forkedFrom || prev?.forkedFrom || undefined
  }
  const next = man.filter((w) => w.name !== name).concat(entry)
  // Atomic manifest write: temp + rename, so a crash never leaves a half-written
  // manifest.json (which would make readManifest silently drop the whole library).
  const mf = authoredManifestPath()
  writeFileSync(`${mf}.tmp`, JSON.stringify(next, null, 2))
  renameSync(`${mf}.tmp`, mf)
  return { name, version: entry.version, origin: 'authored' }
}

// ---------------------------------------------------------------------------
// Integration-data registry — the CLOSED allowlist a widget's bridge can fetch.
// Each entry: an exact upstream URL + a normalize(json) -> [{label,sub?,icon?,
// badge?,url?}] so every provider returns the same shape for generic widgets.
// ---------------------------------------------------------------------------

export const PROVIDER_DATA = {
  discord: {
    guilds: {
      url: 'https://discord.com/api/v10/users/@me/guilds',
      normalize: (json) =>
        Array.isArray(json)
          ? json.map((g) => ({
              label: g.name,
              sub: g.owner ? 'owner' : undefined,
              icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : undefined,
              url: `https://discord.com/channels/${g.id}`
            }))
          : null
    }
  },
  github: {
    repos: {
      url: 'https://api.github.com/user/repos?per_page=50&sort=updated',
      normalize: (json) =>
        Array.isArray(json)
          ? json.map((r) => ({
              label: r.full_name || r.name,
              sub: r.description || undefined,
              badge: r.private ? 'private' : r.stargazers_count ? `★ ${r.stargazers_count}` : undefined,
              url: r.html_url
            }))
          : null
    }
  }
}

/** "provider/resource" strings the bridge can serve (for docs + validation). */
export function listProviderResources() {
  const out = []
  for (const [p, rs] of Object.entries(PROVIDER_DATA)) for (const r of Object.keys(rs)) out.push(`${p}/${r}`)
  return out
}

/**
 * Fetch one (provider,resource) with a caller-supplied bearer token and normalize
 * it to { items:[...] }. The (provider,resource) pair MUST be in PROVIDER_DATA —
 * unknown pairs throw 404 (never a constructed URL). Token comes from the caller's
 * own store; this module never reads tokens. Errors carry a numeric `.code`.
 */
export async function fetchProviderResource(provider, resource, token) {
  // Back-compat shim: the simple (provider,resource) data bridge now rides the general engine
  // (server-side token injection, SSRF gate, default-deny redaction). Same { items } output, so the
  // widget data path (widgets.ts / backend.mjs) is unchanged. The 2 seed resources use access_token.
  const route = resourceRoute(provider, resource)
  if (!route) throw Object.assign(new Error(`unknown data resource "${provider}/${resource}"`), { code: 404 })
  if (!token) throw Object.assign(new Error(`${provider} is not connected`), { code: 401 })
  const r = await callProvider(
    { provider, method: 'GET', path: route.path, query: route.query, caller: { kind: 'widget' } },
    { record: { secrets: { access_token: token } } }
  )
  if (!r.ok) {
    const code = r.status === 401 || r.status === 403 ? 401 : 502
    throw Object.assign(new Error(r.error || `${provider}/${resource} request failed`), { code })
  }
  const items = route.normalize ? route.normalize(r.data) : r.data
  if (!Array.isArray(items)) {
    throw Object.assign(new Error(`${provider}/${resource} returned an unexpected shape (token expired?)`), { code: 502 })
  }
  return { items }
}

// ---------------------------------------------------------------------------
// The authoring contract the AGENT fetches before writing a widget. This is the
// authoritative description of the `window.blitz` bridge (the renderer-injected
// shim implements it). Keep it in sync with src/renderer/src/widget-bridge.ts.
// ---------------------------------------------------------------------------

export const WIDGET_AUTHORING_MD = `# Authoring a BlitzOS widget

A widget is a single self-contained HTML document rendered as a **sandboxed**
\`srcdoc\` surface (\`sandbox="allow-scripts"\` — no same-origin, no network). So:

- **\`fetch()\` / XHR DO NOT WORK inside a widget.** Your only way to get data is the
  OS bridge, injected for you as **\`window.blitz\`** (you don't add it; it's always there).
- Inline everything (CSS + JS in the one HTML string). No external \`<script src>\`/\`<link>\`.

## The \`window.blitz\` bridge

\`\`\`js
// Read normalized data from a CONNECTED integration. Resolves to { items:[...] },
// each item: { label, sub?, icon?, badge?, url? }. The FIRST call per provider
// shows the user a one-time consent prompt; if they allow, it resolves, else rejects.
const { items } = await window.blitz.data('discord', 'guilds')

// Per-widget config passed in at spawn time (spawn_widget props / save_widget props):
const p = window.blitz.props()             // current props object (sync)
window.blitz.onProps(p => { /* re-render when props change */ })

// Run code once the bridge is live (props seeded). Safe to call data() before this;
// requests queue until the channel is ready.
window.blitz.ready(props => { /* boot */ })

// More capabilities (each is consent-gated the first time, like data()):
await window.blitz.tool('open_window', { url: 'https://…' }) // call an OS tool: create_surface/open_window/
                                                             // move_surface/update_surface/close_surface/group/provider_call/list_state
window.blitz.sendMessage('hi')             // send a chat message to the agent (the chat widget uses this)
const dir = await window.blitz.listDir('') // list a workspace folder (the file manager uses this)
window.blitz.setProps({ text })            // persist THIS widget's own state, e.g. a note's text — no prompt
\`\`\`

## Use the shared UI kit (don't restyle from scratch)

Every widget gets a component library + design tokens injected (no import needed) so widgets match the OS
and you never reinvent buttons/rows/bubbles. Prefer these over hand-rolled markup:

- Tokens: \`--blitz-accent\`, \`--blitz-bg\`, \`--blitz-surface\`, \`--blitz-text\`, \`--blitz-text-dim\`, \`--blitz-hairline\`, \`--blitz-radius\`.
- Elements: \`<blitz-titlebar>\`, \`<blitz-list>\`, \`<blitz-message role="user|agent">\`, \`<blitz-row name meta kind ext>\` (fires \`open\`), \`<blitz-input placeholder>\` (fires \`send\` with \`detail.text\`), \`<blitz-button>\`. Or imperatively: \`window.blitz.ui.message(role,text)\` / \`.row({...})\` / \`.input({onSend})\` / \`.button(label,onClick)\`.
- Layout/scroll: by default the body is a normal scrolling document — content taller than the surface scrolls, so don't put \`overflow:hidden\` or a fixed \`height\`/\`100vh\` on \`body\` (that clips it). For a fixed app frame — a pinned \`<blitz-titlebar>\`/\`<blitz-input>\` with ONE scrolling region — use a \`<blitz-list>\`; it fills the height and scrolls internally, and the body switches to the fixed frame automatically.

The built-in chat (\`blitz-chat.html\`) and note (\`blitz-note.html\`) are themselves widgets built this way — read them with get_system_ui as templates; the user can have you rewrite them with customize_widget.

Available data resources (provider/resource): ${listProviderResources()
  .map((s) => `\`${s}\``)
  .join(', ')}. Requesting any other pair rejects — to back a widget with a new
resource, that pair must be added to the OS's PROVIDER_DATA registry first.

## Rules

- **Never store secrets in the widget.** Tokens stay in the OS; \`blitz.data\` returns
  only normalized data, never the token.
- **Replacing a widget's html reloads it from scratch** (all in-widget JS state is
  lost). Push live data over \`blitz.data\` / re-render from \`onProps\` — do NOT update a
  widget by rewriting its html.
- Declare what you use: when you \`save_widget\`, set \`needs:['discord']\` so the OS can
  tell the user to connect it.

## Minimal template

\`\`\`html
<!doctype html><meta charset="utf-8">
<style>body{font:13px/1.4 -apple-system,system-ui;margin:0;padding:10px;color:#e6edf3;background:#0e1116}
.row{display:flex;gap:8px;align-items:center;padding:6px;border-radius:8px}.row:hover{background:#1b2230}
img{width:22px;height:22px;border-radius:6px}</style>
<div id="list">Loading…</div>
<script>
  window.blitz.ready(async () => {
    try {
      const { items } = await window.blitz.data('discord', 'guilds')
      document.getElementById('list').innerHTML = items.map(it =>
        '<div class=row>' + (it.icon ? '<img src="'+it.icon+'">' : '') +
        '<span>'+ it.label + '</span></div>').join('') || 'Nothing here.'
    } catch (e) { document.getElementById('list').textContent = String(e.message || e) }
  })
</script>
\`\`\`

Author with \`save_widget { name, html, description, needs, props }\`; it then appears
in \`list_widgets\` for everyone. Fork by \`get_widget_source\` -> edit -> \`save_widget\`
(set \`forkedFrom\` to the original name).`
