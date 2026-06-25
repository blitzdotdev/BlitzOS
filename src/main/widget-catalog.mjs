// Shared, transport-agnostic widget library.
//
// ONE source of truth imported by BOTH agent transports (the Electron desktop
// `agentSocket.ts` and the server-mode `preview/backend.mjs`) so the widget tools
// can never drift between them (the two tool arrays already drifted once — see the
// AGENTS_MD/OS_AGENTS_MD wording diff). Mirrors the control-core.mjs pattern: a
// plain `.mjs` impl + a `.d.mts` for the TS side.
//
// A "widget" is agent-readable, forkable HTML rendered as a sandboxed `srcdoc`
// surface. It reaches the OS ONLY via the postMessage bridge exposed as `window.blitz`
// (the renderer injects the shim). The library is browsable (list/get source),
// forkable (read -> edit -> save), and extensible (save authored widgets back so the
// next agent sees them).

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// A widget's source language IS its file extension (html default; jsx/tsx compile at mount in
// the renderer against the curated import registry below).
const LANGS = new Set(['html', 'jsx', 'tsx'])
const extForLang = (lang) => (lang === 'jsx' || lang === 'tsx' ? lang : 'html')

/** The curated jsx/tsx import registry (bare specifier -> pinned esm.sh URL). Read lazily —
 *  widgetsDir() may depend on BLITZ_WIDGETS_DIR, which the Electron entry sets after import. */
export function runtimeRegistry() {
  try {
    const v = JSON.parse(readFileSync(join(widgetsDir(), 'runtime', 'registry.json'), 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

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
    ...(w.lang && w.lang !== 'html' ? { lang: w.lang } : {}),
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
    html = readFileSync(join(dir, `${name}.${extForLang(entry.lang)}`), 'utf8')
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
    ...(entry.lang && entry.lang !== 'html' ? { lang: entry.lang } : {}),
    ...(entry.forkedFrom ? { forkedFrom: entry.forkedFrom } : {})
  }
}

/**
 * Save an authored widget back into the library (so it's browsable by the next
 * agent). Authored widgets live under widgets/authored/ (gitignored runtime
 * artifacts), separate from the tracked builtin library. Re-saving the same name
 * bumps version. Throws on a bad name / empty html.
 */
export function saveWidget({ name, html, lang = 'html', description = '', needs = [], props = {}, forkedFrom } = {}) {
  if (!NAME_RE.test(name || '')) {
    throw new Error('invalid widget name (use a-z, 0-9, "-"; 2–49 chars)')
  }
  if (typeof html !== 'string' || !html.trim()) throw new Error('html (the widget source) is required')
  if (!LANGS.has(lang)) throw new Error('lang must be "html", "jsx", or "tsx"')
  mkdirSync(authoredDir(), { recursive: true })
  writeFileSync(join(authoredDir(), `${name}.${extForLang(lang)}`), html)
  // Re-saving under a different lang must not leave a stale other-extension sibling behind
  // (getWidgetSource resolves by the manifest's lang — an orphan would shadow nothing but rot).
  for (const other of LANGS) {
    if (extForLang(other) === extForLang(lang)) continue
    try { unlinkSync(join(authoredDir(), `${name}.${extForLang(other)}`)) } catch { /* none */ }
  }
  const man = readManifest(authoredManifestPath())
  const prev = man.find((w) => w.name === name)
  const entry = {
    name,
    description: String(description || ''),
    needs: Array.isArray(needs) ? needs : [],
    props: props && typeof props === 'object' ? props : {},
    version: (prev?.version || 0) + 1,
    ...(lang !== 'html' ? { lang } : {}),
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
// The authoring contract the AGENT fetches before writing a widget. This is the
// authoritative description of the `window.blitz` bridge (the renderer-injected
// shim implements it). Keep it in sync with src/renderer/src/widget-bridge.ts.
// ---------------------------------------------------------------------------

const WIDGET_AUTHORING_BASE = `# Authoring a BlitzOS widget

A widget is a single self-contained document rendered as a **sandboxed** \`srcdoc\`
surface (\`sandbox="allow-scripts"\` — no same-origin: no storage, no cookies, no parent
access). Two languages: plain **HTML** (default, renders verbatim) and **React JSX/TSX**
(\`lang:"jsx"|"tsx"\` — compiled at mount; see "React widgets" below). The real rules:

- **You feed a widget through props** (\`window.blitz\`, injected for you — you never add
  it). The agent fetches data itself (open a web surface, read it) and pushes it in via
  \`spawn_widget\`/\`update_surface\` props; a widget never fetches on its own.
- **Libraries come ONLY from the curated import registry** (React widgets). No other
  external \`<script src>\`/\`<link>\` — an HTML widget inlines everything in the one string.
- A widget cannot reach the OS, the workspace, or other surfaces except via \`window.blitz\`.

## The \`window.blitz\` bridge

\`\`\`js
// Per-widget config passed in at spawn time (spawn_widget props / save_widget props):
const p = window.blitz.props()             // current props object (sync)
window.blitz.onProps(p => { /* re-render when props change */ })

// Run code once the bridge is live (props seeded).
window.blitz.ready(props => { /* boot */ })

// Capabilities (gated by the CLOSED allowlist):
await window.blitz.tool('open_window', { url: 'https://…' }) // call an OS tool: create_surface/open_window/
                                                             // move_surface/update_surface/close_surface/list_state
await window.blitz.tool('close_surface', {}) // close THIS widget; pass {id} only to close another surface
window.blitz.sendMessage('hi')             // send a chat message to the agent (the chat widget uses this)
const dir = await window.blitz.listDir('') // list a workspace folder (the file manager uses this)
window.blitz.setProps({ text })            // persist THIS widget's own state, e.g. a note's text
\`\`\`

## Interactivity by default

A widget is a small app, not a poster. Static is OK only when the content is atomic
(one clock, one KPI, one quote, one status). Lists, comparisons, timelines, maps,
candidate sets, and research outputs should expose at least one meaningful action:
filter, sort, expand details, toggle a view, open the source, or send a follow-up to
the agent. Prefer \`window.blitz.tool('open_window', { url })\` for source rows,
\`window.blitz.sendMessage(text)\` for chat actions, and \`window.blitz.setProps(next)\`
for state the widget itself should remember.

## Review before creating

Before you call \`create_surface\`, \`spawn_widget\`, \`update_surface\`, or \`save_widget\`
with new or changed widget source, read your own code once like a reviewer and fix the
obvious mistakes. This is mandatory for authored, forked, and replacement widgets;
trusted library widgets can be spawned as-is unless you edit them.

- No secrets, tokens, localStorage/sessionStorage, parent/window-top access, external
  scripts, external stylesheets, or network fetches outside the allowed bridge/registry.
- Never declare a top-level \`const\`/\`let\`/\`var\` named after a window global (\`top\`, \`name\`,
  \`parent\`, \`self\`, \`length\`, \`status\`, \`closed\`, \`origin\`, \`event\`, \`location\`). \`const top = ...\`
  throws "Identifier already declared" and aborts the ENTIRE inline script, so the widget renders
  blank with no error on the tile. Name your data \`lead\`, \`first\`, \`rows\`, \`items\` instead.
- Use \`window.blitz\` for OS actions, source-opening rows, chat actions, and durable
  widget props.
- Keep interaction meaningful unless the widget is truly atomic. If a row has a source,
  make it clickable with \`window.blitz.tool('open_window', { url })\`.
- Use Blitz tokens and kit components. Do not paste a separate palette, default-blue
  link styling, or a generic web-card layout. Do not add \`<blitz-titlebar>\` to a plain
  widget.
- Keep scroll safe: no \`overflow:hidden\`, fixed body \`height\`, or \`100vh\` body trap
  unless you intentionally build one internal scroller with \`<blitz-list>\`.
- Keep copy short and polished. No em dashes in human-readable widget text.
- For JSX/TSX, confirm \`export default\`, registry-only imports, valid hook/state
  usage, concrete chart heights, and concrete SVG/chart colors where CSS vars would not
  resolve in attributes.

After mounting or updating a JSX/TSX widget, check \`list_state\` or \`get_surface\` for
\`lastError\`. If it appears, fix the source and update again before calling the widget
done.

## Look like a WIDGET, not a web page (the design language)

A widget is a small mini-app, not a document. The OS already draws the
window chrome; the widget's content must read at a glance:

- **No titlebar.** Do NOT add \`<blitz-titlebar>\` to a widget (it's for full app frames like the
  chat). Identity is a tiny caps LABEL inline at the top, or nothing when the content self-explains:
  \`font:600 9px ui-monospace; letter-spacing:.18em; text-transform:uppercase; color:var(--blitz-accent)\`.
- **One hero element.** The number, the chart, the icon grid, the name — make it BIG (24px+ values,
  9px caps labels); everything else is small and dim. If everything is the same size it's a web page.
- **Almost no words.** No explanatory sentences, no footers, no instructions inside the tile. A
  widget that needs a paragraph to explain itself is the wrong widget.
- **Icons and color over text.** A grid of favicon tiles beats a list of name+button rows; a heat
  ramp beats a table of numbers. Generous padding (14px+), soft corners, no borders-inside-borders.
- The built-in templates (\`profile\`, \`rhythm\`, \`workflows\`, \`quotes\`, \`gaps\`) are the reference set —
  \`get_widget_source\` one before authoring your own.
- **For a data-rich widget, study real references first** (\`open_window\` a couple of dashboard /
  data-viz examples, or web-search the idiom) so the SHAPE fits the data. But hold the one-hero,
  almost-no-words discipline above: a clean headline plus one clear chart beats a busy "designed"
  tile. Richer is not the goal; legible-at-a-glance is, and a thin dataset wants the simpler layout.

## Use the shared UI kit (don't restyle from scratch)

Every widget gets a component library + design tokens injected (no import needed) so widgets match the OS
and you never reinvent buttons/rows/bubbles. Prefer these over hand-rolled markup:

- Tokens: \`--blitz-accent\`, \`--blitz-bg\`, \`--blitz-surface\`, \`--blitz-text\`, \`--blitz-text-dim\`, \`--blitz-hairline\`, \`--blitz-radius\`.
- **Color:** spawn any widget with \`props.accent\` (+ optional \`props.accentInk\`) and its \`--blitz-accent\` recolors automatically — no widget code needed. Sample accents from the Blitz paper palette tokens: \`--blitz-coral #FF8D61\` (signature), \`--blitz-terracotta\`, \`--blitz-sage\`, \`--blitz-slate\`, \`--blitz-dust\`, \`--blitz-mauve\`, \`--blitz-tan\`, \`--blitz-marker\`. Vary accents across a set of widgets (a distribution, not one color).
- **Copy:** any text the human reads inside a widget follows the OS prose rules (manual, "Talking with the user"): absolutely NO em dashes (—); plain, tight sentences; bold sparingly; say what is missing instead of guessing.
- Elements: \`<blitz-titlebar>\` (full APP frames like the chat only — never on a plain widget, see the design language above), \`<blitz-list>\`, \`<blitz-message role="user|agent">\`, \`<blitz-row name meta kind ext>\` (fires \`open\`), \`<blitz-input placeholder>\` (fires \`send\` with \`detail.text\`), \`<blitz-button>\`, \`<blitz-edit value placeholder [multiline]>\` (an inline editable field — fires \`change\`/\`input\` with \`detail.value\`; for an editable plan-stage title/detail), \`<blitz-toggle on label>\` (a pill switch — fires \`change\` with \`detail.on\`; for a per-decision yes/no). Or imperatively: \`window.blitz.ui.message(role,text)\` / \`.row({...})\` / \`.input({onSend})\` / \`.button(label,onClick)\` / \`.edit({value,placeholder,multiline?,onChange,onInput?})\` / \`.toggle({label,on,onChange})\`.
- Layout/scroll: by default the body is a normal scrolling document — content taller than the surface scrolls, so don't put \`overflow:hidden\` or a fixed \`height\`/\`100vh\` on \`body\` (that clips it). For a fixed app frame — a pinned \`<blitz-titlebar>\`/\`<blitz-input>\` with ONE scrolling region — use a \`<blitz-list>\`; it fills the height and scrolls internally, and the body switches to the fixed frame automatically.

The built-in chat (\`blitz-chat.tsx\` by default, with legacy/custom \`blitz-chat.html\` still supported) and note (\`blitz-note.html\`) are themselves widgets built this way — read them with get_system_ui as templates; the user can have you rewrite them with customize_widget.

## Editable / interactive widgets (forms, plans, anything the USER changes)

Most widgets are read-only dashboards the agent drives. Some are TWO-WAY: the user edits the
widget (reorders steps, toggles a choice, types a note, taps Submit) and those edits must reach
YOU so you can act on them. The classic case is a **plan widget** the user approves/edits before a
job runs, but the same idiom covers any form, checklist, or approval card.

**The data contract — keep ALL editable state in one props object, mirror every edit into it.**
A widget reloads from scratch when its html is replaced and loses in-widget JS state on any reload, so
the source of truth for what the user has changed is \`props\`, not React state. On every edit, write the
change back with \`window.blitz.setProps(next)\` (durable, own-surface) AND keep it in local state for the
live render. Then a reload or an agent \`update_surface\` re-seeds from the same shape via \`onProps\`.

Example shape for a plan (adapt the field names to your task):

\`\`\`js
// props = the single source of truth — seed from blitz.props(), re-render from onProps, write every edit back.
{
  mode: 'edit',                                   // 'edit' while planning; the agent flips it to 'status' on approval
  agentId: '7',                                   // the owning job/workflow agent; always pass to sendMessage
  jobId: '7',                                     // optional external work-unit id, if your runtime has one
  stages: [ { id:'s1', title:'…', detail:'…', status:'todo' }, … ],  // editable, reorderable, removable rows
  decisions: { useStaging: true, notify: false }, // per-decision toggles (a map of named yes/no choices)
  comments: '',                                   // a free-text box the user can leave for you
  decision: null                                  // set to 'approve' | 'reject' | 'edit' when the user acts
}
\`\`\`

Render it with the kit: \`<blitz-edit>\` for each stage title/detail (fires \`change\`/\`input\` with \`detail.value\`),
\`<blitz-toggle>\` for each decision (fires \`change\` with \`detail.on\`), small \`<blitz-button>\`s for reorder (▲/▼) and
remove (✕) per row, a multiline \`<blitz-edit>\` or a \`<textarea>\` for comments, and \`<blitz-button>\`s for Submit /
Reject. On EVERY change handler: update local state, then \`blitz.setProps({ stages, decisions, comments })\` so the
edit survives a reload. (Give each row a STABLE \`id\` so reorder/remove never mixes rows up.)

**The RETURN CHANNEL — how the user's edits get back to the agent (the recommended two-step).**
The widget can talk to the agent two ways. The robust one for a large edited payload is:

1. On Submit/Reject, write the FULL final state into your own props and set the decision:
   \`await window.blitz.setProps({ stages, decisions, comments, decision: 'approve' })\` (or \`'reject'\`).
2. Then wake the agent with a TINY message — the payload rides in props, not in the message:
   \`window.blitz.sendMessage('plan approve', window.blitz.props().agentId)\`.
   Passing \`props.agentId\` routes the wake to the JOB's agent (omitting it wakes the primary agent '0' instead —
   always pass it for a job widget; the agent that spawned the widget seeds it in props).

The agent then reads the full edited plan with \`get_surface {id}\` (which returns the widget's complete props,
sidestepping the size cap below), reconciles it, and updates the widget back via \`update_surface {props}\`.

**Agent-side plan binding and reconcile loop.** When this widget represents a job plan, the agent owns the durable
work record and the \`plan.md\`; the widget is the user's editable view of that same plan. Use this protocol:

1. Draft the staged plan, then spawn the widget with the full editable props:
   \`spawn_widget { name:'plan', props:{ mode:'edit', agentId, jobId, stages, decisions, comments:'' } }\`.
2. Capture the returned surface \`id\` and bind it to the work record as \`planSurfaceId\`. If the runtime exposes a
   status/update tool, write that field there immediately. If no such work record/tool exists, do not fake one; leave
   an explicit TODO in your task notes and keep using the returned surface id locally.
3. Write the same staged plan to the job's \`plan.md\` using the parser's grammar: a machine-readable \`status:\`
   line plus checklist-style stage rows with stable titles/statuses. Prefer the runtime's \`writePlan\` helper when
   available, because E1/continuation reads that same file with \`readPlan\`.
4. Ask the user to approve, edit, or reject in the widget. Do not start execution from your own draft.
5. On a wake like \`plan approve\` or \`plan reject\`, look up the bound \`planSurfaceId\`, call \`get_surface {id}\`,
   check \`surface.props.lastError\`, normalize \`stages\`/\`decisions\`/\`comments\`/\`decision\`, then write BOTH the
   normalized widget props with \`update_surface {id, props}\` and the reconciled \`plan.md\`.
6. Only after a user-originated approve should the job transition to execution (for runtimes with job status, that is
   the \`set_job_status ... running\` edge). A reject or edited plan loops back through the same widget and \`plan.md\`.

**The direct channel (\`__blitz:'action'\`) — small payloads only, it has a hard cap.** A sandboxed widget can also
postMessage \`{ __blitz:'action', surfaceId, … }\` straight to the OS, which delivers it to the agent as a
\`trigger:'action'\` moment carrying the whole object on the moment's \`action\` field — no \`sendMessage\`/\`get_surface\`
round-trip. BUT the serialized message is **capped at 4000 BYTES and SILENTLY DROPPED if it exceeds that** (a
renderer security limit). So use \`__blitz:'action'\` only for a SMALL signal (a button id, a single choice, a short
note); for anything that could grow — an edited multi-stage plan, a comments box, a list — use the two-step above
(\`setProps\` + a tiny \`sendMessage\`), because the plan lives in props and is read with \`get_surface\`, never squeezed
through the 4000-byte action channel where a big edit would vanish with no error.

\`\`\`js
// direct channel — ONLY for a small, bounded signal (NOT a full plan):
window.parent.postMessage({ __blitz: 'action', surfaceId: window.blitz.props().surfaceId, kind: 'stage-toggle', id: 's1', on: true }, '*');
\`\`\`

After the agent calls \`update_surface\` on a two-way widget, it should re-check \`get_surface\`/\`list_state\` for
\`props.lastError\` — an agent-pushed prop change lands silently, so a failed update is only visible on the next read.

## Rules

- **Never store secrets in the widget.** A widget never fetches; the agent gathers data
  (open a web surface, read it) and pushes it into props.
- **Replacing a widget's html reloads it from scratch** (all in-widget JS state is
  lost). Push live data over props / re-render from \`onProps\` — do NOT update a widget
  by rewriting its html.

## Minimal template

The agent gathers the rows and passes them in via props (\`spawn_widget {name, props:{items}}\`);
the widget renders them and re-renders on \`onProps\` as the agent drives it.

\`\`\`html
<!doctype html><meta charset="utf-8">
<style>body{font:13px/1.4 -apple-system,system-ui;margin:0;padding:10px;color:#e6edf3;background:#0e1116}
button.row{width:100%;border:0;color:inherit;background:transparent;font:inherit;text-align:left;cursor:pointer}
.row{display:flex;gap:8px;align-items:center;padding:6px;border-radius:8px}.row:hover{background:#1b2230}</style>
<div id="list">Nothing yet.</div>
<script>
  function render(p) {
    const items = (p && p.items) || []
    const list = document.getElementById('list')
    list.textContent = ''
    for (const it of items) {
      const row = document.createElement(it.url ? 'button' : 'div')
      row.className = 'row'
      if (it.url) row.onclick = () => window.blitz.tool('open_window', { url: it.url })
      const label = document.createElement('span'); label.textContent = it.label; row.appendChild(label)
      list.appendChild(row)
    }
    if (!items.length) list.textContent = 'Nothing yet.'
  }
  window.blitz.ready(render)
  window.blitz.onProps(render)
</script>
\`\`\`

Author with \`save_widget { name, html, lang?, description, props }\`; it then appears
in \`list_widgets\` for everyone. Fork by \`get_widget_source\` -> edit -> \`save_widget\`
(set \`forkedFrom\` to the original name).`

// The React-widget section is appended lazily so the import registry list always reflects
// widgets/runtime/registry.json on disk (and widgetsDir()'s env override is set by then).
function jsxAuthoringSection() {
  const reg = runtimeRegistry()
  const specs = Object.keys(reg)
  return `

## React widgets (lang: "jsx" | "tsx")

Pass \`lang:"jsx"\` (or \`"tsx"\`) with the SAME \`html\` field carrying JSX source — to
create_surface, update_surface, or save_widget. Locally, a \`<name>.jsx\` file in the
workspace folder surfaces one too. The OS compiles it at mount (Sucrase, strip-only,
no type-check) and mounts your \`export default\` component — no boilerplate, no build.

- **Imports — curated registry ONLY** (pinned, cached): ${specs.map((s) => `\`${s}\``).join(', ')}.
  Any other specifier fails to resolve. \`react\` is v19.
- \`window.blitz\` and the \`<blitz-*>\` elements work exactly as in HTML widgets — call the
  global directly, no import. Custom elements are fine in JSX (\`<blitz-button onClick=…>\`).
- **Errors are readable**: a compile or runtime failure paints an error card AND lands in
  the surface's \`lastError\` (visible in list_state). After update_surface, re-check
  list_state — \`lastError\` gone means the widget mounted clean.
- When to use which: jsx for stateful/data-heavy widgets (live charts, springs, markdown,
  lists that update); plain html stays right for a simple static tile. **React buys you
  CAPABILITY, not looks — a React widget styled lazily looks WORSE than a vanilla one.
  The design rules below are not optional.**

### Make it look like a BlitzOS widget (do this — it's the whole difference)

The same design language as HTML widgets applies, and it's what separates a polished tile
from a generic card. **Fork a reference instead of styling from scratch**: \`get_widget_source\`
one of \`kpi-spark\` (recharts), \`kpi-counter\` (framer-motion), \`status-list\` (lucide),
\`markdown-card\` (react-markdown) — they ARE the house bar; adapt them.

- **Tokens, never hardcoded hex.** Use \`var(--blitz-accent)\`, \`var(--blitz-text)\`,
  \`var(--blitz-text-dim)\`, \`var(--blitz-hairline)\`, \`var(--blitz-surface)\` in your styles.
  Hardcoding \`#e31c30\`/\`#999\` is the #1 reason a widget looks off — it ignores the OS theme
  and the per-widget \`props.accent\`. (Semantic up/down green/red is the one ok exception.)
- **One hero, tiny everything-else.** A 9px UPPERCASE accent kicker
  (\`font:'600 9px ui-monospace',letterSpacing:'.18em',color:'var(--blitz-accent)'\`), then ONE
  big hero (34-46px, \`fontWeight:700\`, \`letterSpacing:'-.03em'\`, \`fontVariantNumeric:'tabular-nums'\`),
  everything else small and dim. Same-size text everywhere = a web page, not a widget.
- **No titlebar, almost no words, generous padding** (16-20px), soft hairlines not boxes.

### SVG colors don't read CSS vars (charts + icons)

\`var(--blitz-accent)\` works in normal CSS, but NOT in an \`<svg>\` fill/stroke ATTRIBUTE.

- **recharts:** read the concrete accent once and pass it —
  \`const accent = getComputedStyle(document.documentElement).getPropertyValue('--blitz-accent').trim()\`,
  then \`stroke={accent}\` / \`stopColor={accent}\`. Also give the chart a **concrete height**
  (a sized parent or \`height={120}\`) — a flex/0-height parent renders an invisible chart.
- **lucide-react:** icons stroke with \`currentColor\`, so theme via CSS color —
  \`<Icon style={{ color: 'var(--blitz-accent)' }}/>\`, NOT the \`color\`/\`stroke\` attribute.

\`\`\`jsx
// minimal well-formed widget: accent kicker + one hero, tokens throughout
import { useState, useEffect } from 'react'
export default function Clock() {
  const [p, setP] = useState(blitz.props())
  const [now, setNow] = useState(new Date())
  useEffect(() => blitz.onProps(setP), [])
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t) }, [])
  const flip = () => { const format = p.format === '24h' ? '12h' : '24h'; setP({ ...p, format }); blitz.setProps({ format }) }
  return (
    <div onClick={flip} style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8, padding: '0 20px', cursor: 'pointer' }}>
      <div style={{ font: '600 9px ui-monospace,monospace', letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--blitz-accent)' }}>Local time</div>
      <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: '-.03em', fontVariantNumeric: 'tabular-nums', color: 'var(--blitz-text)' }}>
        {now.toLocaleTimeString(undefined, { hour12: p.format !== '24h' })}
      </div>
    </div>
  )
}
\`\`\``
}

/** The full authoring guide (base + the React section with the live registry list). */
export function widgetAuthoringMd() {
  return WIDGET_AUTHORING_BASE + jsxAuthoringSection()
}
