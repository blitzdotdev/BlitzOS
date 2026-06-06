# BlitzOS Persistence & Serialization — Workspaces Design

**Status:** design spec, ready to build. Supersedes the in-memory-only store.
**Provenance:** synthesized from a 14-agent brainstorm (ground → 7 design lenses → 5 adversarial critiques → synthesis), Opus-only, 2026-06-06. Critic findings that drove a decision are tagged inline as **[resolves: …]**.
**Reconciliation note:** the brainstorm deliberately overruled two things settled in earlier discussion — *per-item sidecar metas* (→ one central `workspace.json`) and *full two-way field-merge* (→ one-way layout authority + editor-style content reload). Rationale is inline; see "Open decisions" §12 and the chat thread for the forks left to the user.

---

## 1. The model in one page

A **workspace is a folder on disk.** Open a folder, you get a canvas; every canvas node is a real file in that folder; restart and the canvas comes back; the connected agent reads and edits those files directly with its normal file tools. That is the whole idea. Everything below serves it.

Six mechanics make it click:

1. **Everything is a file.** A note is a `.md`. A web window is a `.weblink` (`{"url":…}`). A widget is a `.widget/` bundle. A dropped PDF is the PDF. Content files hold **only** content — pristine, so `git diff idea.md` shows the user's words and a `.png` is a real `.png`.

2. **One central layout file, not per-item sidecars.** Geometry, z-order, kind, and view-state for every on-canvas node live in **one** `.blitzos/workspace.json`. **[resolves: scale-critic (boot = N reads, write-amplification, git-churn) and coherence-critic (mirror-tree desync) — there is no per-file meta mirror to keep structurally consistent, no N-write storm on a drag, no inode/xattr identity chain.]** A `nodes[]` array indexed by stable id is the source of truth for layout; the content files are the source of truth for content.

3. **One-way authority, not live field-merge.** BlitzOS **owns** `workspace.json` (geometry/layout). The folder is watched only to notice content edits and file add/remove/rename, which trigger an **idempotent re-scan**. Content is reloaded whole-file, last-writer-wins, exactly like an editor reloading a file changed on disk. **[resolves: simplicity-critic + concurrency-critic — no three-way merge, no baseline, no CAS, no conflict-copies, no hash-keyed echo ledger, no drag-queue. The concurrent-multi-writer-racing-the-same-field scenario those mechanisms defend does not exist for one human + one agent on one machine.]**

4. **Folder kinds, by extension, three of them.** A plain folder = a collapsed tile (contents off-canvas — a cloned repo is one node, not 5000). A `.widget/` = an opaque runnable bundle. Everything else loose at the root = a node. **[resolves: simplicity-critic — `.group` and frame-relative coordinates are cut from v1; grouping = drop into a plain folder.]**

5. **The agent is a peer editor, not a gatekeeper's client.** A co-located agent (Electron-local, or on the server box) reads/writes workspace files with its own tools — no API for anything with a file form. A self-describing `BLITZOS.md` in every workspace teaches the format. HTTP tools remain only for things a file cannot express: acting **inside** a live web surface (click/type/read/screenshot) and the perception long-poll.

6. **Secrets are never in the folder.** No login cookie, no OAuth token, no content-share grant ever lives in a workspace file. The folder is portable, git-able, cloud-syncable precisely because the dangerous bytes are elsewhere. **[resolves: security-critic — consent stays session-scoped and out of files; browser profiles live outside every workspace.]**

The mental shift: **the store stops being the origin and becomes a projection of `workspace.json` + the folder.** But only for *durable* state — live runtime (the webContents handle, CDP attachment, screencast, "is it loaded yet", live page title) is born at render and never serialized. **[resolves: coherence-critic — "folder is the single source of truth" is true for durable state only; `list_state` stays a merge of folder-intent ⊕ live-runtime.]**

---

## 2. On-disk layout

```
~/Blitz/acme/                          ← the workspace = this folder. ONE per root.
│
├── BLITZOS.md                         ← self-describing format doc. Tracked. The agent reads this first.
├── .gitignore                         ← generated. Ignores .blitzos/state/ (see §3).
│
├── idea.md                            ← a note. Content = pure markdown, nothing else.
├── pricing.weblink                    ← a web window.  {"url":"https://stripe.com/pricing"}
├── logo.png                           ← a dropped image. The file itself.
├── report.pdf                         ← a dropped file. The file itself.
│
├── clock.widget/                      ← a *.widget bundle: opaque, RUNS as one node. Double-click launches.
│   ├── manifest.json                  ←   {kind,name,entry,needs,version,forkedFrom}
│   └── index.html
│
└── acme-api/                          ← a PLAIN folder (a cloned git repo) = ONE collapsed tile.
    └── … 5000 files …                 ←   NONE of these surface. Off-canvas. Repo-safe.
                                            (No nested .blitzos. No recursion.)

└── .blitzos/                          ← THE one meta dir. Never nested.
    ├── workspace.json                 ← SOURCE OF TRUTH for layout: camera, mode, version, nodes[].
    └── state/                         ← OS-runtime state. NOT user content. gitignored. Agent-READ-DENIED (§9).
        ├── chat.jsonl                 ←   in-canvas chat log (append-only)
        └── activity.jsonl             ←   agent activity feed (append-only; not load-bearing, fine to lose)
```

Deliberately **absent** vs the brainstorm: no `.blitzos/meta/` mirror tree, no per-node `*.json` sidecars, no `*.group/`, no `*.app/`/`.applink`, no `runtime/baseline.json`, no `.blitzos/.lock` heartbeat, no per-workspace browser profile, no `consent.json` in v1. Each is cut or deferred below with a reason.

Credentials live **outside** every workspace, in the existing trust zone:
```
~/Library/Application Support/BlitzOS/   (app.getPath('userData'))
├── integrations.json                    ← Keychain-encrypted OAuth (unchanged)
├── workspaces.json                      ← recents registry: [{path,name,lastOpened}]. OS-written only.
└── (Chromium partition data)            ← browser sessions (unchanged: one global profile in v1)
```

---

## 3. Schemas

### 3.1 `workspace.json` — the single source of truth for layout

JSON (not JSONC: it is OS-written and round-tripped; comment loss is the bigger evil). Written atomically (temp + `fsync` + rename), with the previous copy kept as `workspace.json.bak` for boot fallback.

```jsonc
{
  "version": 1,                           // int, ≥1. Bump = migration. No version:0 ever.
  "id": "01J9Z3WORKSPACEULID000000",      // ULID, minted at scaffold. Server-mode tenant key.
  "kind": "blitzos.workspace",            // const. Lets a tool sniff "this folder is a workspace".
  "camera": { "x": 0, "y": 0, "scale": 1 },// world px, origin-centered. scale clamped 0.2–3 on load.
  "mode": "desktop",                       // "desktop" (Electron) | "canvas" (server). Default per mode.
  "stack": ["01J9..A", "01J9..B"],        // z-order: array of node ids, back→front.
  "nodes": [
    {
      "id": "01J9Z8K3QH7M2",              // ULID. Stable. Minted once. NOT derived from filename.
      "path": "idea.md",                   // workspace-relative POSIX path to the content file.
      "kind": "note",                      // resolved kind (note|web|srcdoc|widget|image|file|folder).
      "x": -210, "y": -64, "w": 240, "h": 240,  // geometry, world px.
      "zoom": 1,                           // content zoom, 0.3–3.
      "view": { "color": "yellow" }        // per-kind view state. small, optional. (§3.3)
    }
  ]
}
```

**Decisions baked in:**

- **z is the `stack` array, not a per-node `z` field.** Bring-to-front = move an id to the end of one array = one small change to one file. **[resolves: scale-critic + coherence-critic — no monotonic `z` counter rewriting N entries on every focus; no load-time z-renormalization write-back. Note today's `moveSurface` bumps `z` on every pointer move — that pattern dies.]** The store keeps `zCounter` internally only as a session render-order allocator.
- **No `updatedAt` / `rev` / `createdAt` in the persisted node.** They are the only always-changing fields and generate git noise for zero value. Self-write suppression keys on a path+mtime window instead (§5).
- **`path` is re-validated jail-confined on every read/write** (§9), never trusted as written.

### 3.2 Versioning

`version: 1`, and nothing else, in v1. No migration ladder, no forward-compat unknown-field preservation. When v2 is designed, add a single `migrate(ws)` whose shape is known then. Boot reads `version`; if greater than the running build supports, open **read-only with a banner** (the only forward-compat we pay for now).

### 3.3 Per-node-kind serializable state

Hard rule: **content in the content file, geometry/view in `workspace.json`, nothing else anywhere.** The old `props` blob is dissolved.

| Kind | Content file | `view` (in workspace.json) | NEVER persisted |
|---|---|---|---|
| **note** | `*.md` — markdown only | `{ "color": "yellow" }` | geometry-in-the-md (no front-matter), font |
| **web** | `*.weblink` — `{"url":"…"}` | `{ "lastTitle": "…" }` (cosmetic label pre-load) | **the login/cookie/session** (browser profile, §7); live DOM; live title; scroll |
| **srcdoc** | `*.html` — the HTML | `{ "props": {…} }` | in-page JS runtime (reloads from scratch) |
| **widget** | `*.widget/` bundle | `{ "props": {…}, "origin": "builtin:discord-servers" }` | **integration tokens** (Keychain); fetched data; **consent grant** (§9, session-only) |
| **image** | the image | `{ "fit": "contain" }` | any interpretation |
| **file** | the file | `{}` | any interpretation |
| **folder** | a directory | `{ "kindHint": "git-repo" }` | anything about contents (one node for N files) |

The headline browser-login row: **a `.weblink` carries a URL and nothing authenticating.** That is what makes it portable. The session that makes `mail.google.com` show *your* inbox lives in the Chromium profile, outside the folder.

**Chat & activity are not nodes and not content.** Their logs append to `.blitzos/state/chat.jsonl` / `activity.jsonl` (JSONL = a crash tears at most the last line). Activity is not load-bearing; on restart it may start empty. Chat persists; no rotation machinery in v1.

---

## 4. Folder kinds

A node's kind is a **pure function of the dirent** (`kindOf(name, isDir)`), plus an **ancestry predicate** for whether it surfaces:

```
kindOf(name, isDir):
  if isDir:
    if name.endsWith('.widget'): return 'widget'   // opaque bundle, runs as one node
    return 'folder'                                  // plain dir → collapsed tile
  ext = extname(name)
  if ext === '.weblink': return 'web'                // INVENTED ext: extension wins (can't collide)
  if ext in IMAGE_EXTS: return 'image'               // REAL exts: passive tiles by default
  if ext === '.md': return 'note'
  return 'file'                                       // generic tile, opens externally

surfaces(path):  // surfaces IFF no plain-folder ancestor up to root
  return path has NO plain-folder ancestor
```

| Kind | On canvas | Double-click | Children surface? |
|---|---|---|---|
| **plain folder** | one collapsed tile (icon + count) | descend / open in Finder | **No** — off-canvas, repo-safe |
| **`.widget/` bundle** | one node, runs | launch the surface | **No** — opaque |
| **loose file** (note/web/image/file) | one node | edit / focus / open | n/a |

**Resolutions folded in:**

- **`.html` does NOT auto-execute as srcdoc, and `.app` is not a kind.** A dropped `report.html` or a repo's `index.html` is a passive `file` tile that opens externally, never a running sandboxed surface. Agent-authored srcdoc is created *through BlitzOS* (which writes the `.html` and records `kind:"srcdoc"` in `workspace.json`); for that ambiguous real extension, **the node entry — not the extension — decides it is srcdoc.** **[resolves: coherence-critic (extension collisions) + security-critic (downloaded HTML auto-running).]**
- **`.group` is cut.** Grouping = "drag onto a plain folder = `mv` into it." No inline children, no frame-relative coordinate space. Deferred to "later" as a pure-UI layer needing no new persistence concept.
- **No extensible kind registry.** `kindOf` is a hardcoded switch over the cases above. A `KindDef` registry arrives the day a kind must be registered from outside core — not now.

---

## 5. Two-way sync algorithm (the crux, made small)

BlitzOS owns layout; the folder is watched to reflect external content/structure edits. There is **no merge engine**.

### 5.1 Write path (BlitzOS → disk)

Mutations are tiered, reusing the codebase's existing `snapshotLayout` quiet-period instinct:

- **Geometry / z / camera / view** → debounced 400ms (+ flush on drag-end and `before-quit`) → write `workspace.json` once. **No `fsync`** (low stakes; losing the last 400ms of a drag is invisible).
- **Content** (note text, weblink url, srcdoc html) → debounced 800ms (+ flush on blur/close/quit) → atomic write of the content file.
- **Structural** (create / close / move-between-folders) → immediate, atomic.

Every write is **temp + rename**, same directory, same filesystem. The non-atomic `.html` write in `widget-catalog.mjs` is fixed to match.

**There is no content+meta two-file transaction, so there is no torn-rename identity loss.** Because layout is one file and content another, the only multi-file moment is "create a node": write content file, then add the node to `workspace.json`. A crash between → boot reconcile sees a loose file with no node entry → auto-places it (Rule A). Worst case is "a file gets a default position," never lost identity. A rename of a BlitzOS-owned node is one atomic `workspace.json` write that changes `path`; the content-file `mv` and the path-field update are sequenced so `path` points at wherever the file actually is, and a re-scan heals any gap.

### 5.2 Watch path (disk → BlitzOS)

Watch is a **doorbell, not a semantic source** — never trust `fs.watch` rename pairing or event payloads.

- **Electron:** watch the workspace **root** content + `.blitzos/workspace.json`, plus a short poll of `.blitzos/`. On any event, after a 250ms coalescing window, run **reconcile** (full re-scan). A 1000-file `git checkout` → one reconcile, not 1000.
- **No recursive watch.** Plain folders are not watched (contents off-canvas). **[resolves: scale-critic — no inotify descriptor exhaustion; no mirror-tree-needs-recursive-watch contradiction, because there is no mirror tree.]**

### 5.3 Reconcile (idempotent, no baseline, no merge)

```
reconcile():
  ws = read workspace.json                          // layout source of truth
  files = scan loose root files + .widget bundles   // surfacing files only (ancestry predicate)
  for each node in ws.nodes:
     if file at node.path exists:  keep; reload content if it changed (whole-file LWW)
     if file gone:
        match = exactly one unmatched file of compatible kind?   // rename heuristic
        if match: node.path = match.path                          // re-point (HEAL)
        else:     mark node "missing" (ghost card; user dismisses or relocates)
  for each surfacing file with NO node entry:
     auto-place: mint ULID, kindOf(), cascade position → add node   // Rule A
  project ws.nodes ⊕ live-runtime → store
```

Reconcile is **idempotent** — running it twice yields the same store. That property makes self-write suppression cheap.

### 5.4 Self-write suppression

**An optimization, not a correctness requirement.** **[resolves: concurrency-critic — the lost-update-on-identical-bytes hazard is impossible because a missed suppression just triggers an idempotent re-scan producing an identical store.]** Mechanism: when BlitzOS writes a path, record `(path, mtime)` for 500ms; a matching watch event is ignored. A miss costs one redundant re-scan, never a dropped edit. No content hashing, no per-path ledger, no `rev` field.

### 5.5 Rename / identity

ULID is identity; it lives in the node entry. **In-OS renames** move the content file and update `node.path` together. **External renames** (Finder/VS Code touch only the content file) are healed by §5.3: file gone + exactly one compatible unmatched file → re-point. **Ambiguous renames are NOT silently re-paired** — the new file becomes a fresh auto-placed node, the old entry becomes a "missing" ghost the user resolves. The earlier "Finder rename auto-heals losslessly" promise is honestly downgraded to **"best-effort, unambiguous single rename,"** documented in `BLITZOS.md`. **[resolves: concurrency/coherence/scale critics — no inode/xattr/content-hash chain; identical-content `.weblink`s can't mispair.]**

### 5.6 The renderer↔main loop

A reconcile-driven store update is tagged `origin:"disk"` on the IPC so main's write-back does **not** re-diff it into a disk write — a hand-edited file is not rewritten by the next render cycle. Auto-place needs the renderer's viewport for cascade, so the auto-place *write* originates in the renderer after hydrate, then flows to main as a normal structural write.

### 5.7 Conflict policy

- **Geometry:** BlitzOS owns it. A human hand-editing `workspace.json` mid-drag is self-inflicted; last-writer-wins.
- **Content:** whole-file last-writer-wins, editor-style. No field merge, no `.conflict` copies. If a live note surface has unsaved text and the file changes on disk, the surface reloads (matching every code editor's "file changed on disk" behavior).

---

## 6. The agent contract

### 6.1 Reading & editing — directly, no API

A **co-located agent** (Electron-local via the localhost control server, or running on the server box) operates the workspace with its **own file tools**:

| Intent | What the agent does |
|---|---|
| see the board | `ls` the folder; `cat idea.md`; read `.blitzos/workspace.json` for geometry/camera |
| new note | `write idea.md "…"` → reconcile auto-places it |
| open a site | `write stripe.weblink '{"url":"https://stripe.com"}'` |
| edit a note | `edit idea.md` |
| move / resize | edit the node's entry in `.blitzos/workspace.json` |
| rename | `mv idea.md plan.md` → re-paired by §5.5 |
| group | `mkdir archive/ && mv old.md archive/` |
| delete | `rm idea.md` (its node entry drops on reconcile) |

Atomicity is **safe by construction**: write content-then-update-layout; a crash between yields an auto-placed node, never corruption. The agent never needs a transaction.

### 6.2 BLITZOS.md

First-run scaffolds a `BLITZOS.md` that teaches the format from the folder itself (an agent with zero context that `ls`-es a strange folder learns what it is): the kind table, "the board = this folder," "to act, edit files," `workspace.json` for geometry/camera, "your memory IS this workspace — keep notes as `_context.md`," the unambiguous-rename caveat, and the file-vs-API boundary.

### 6.3 The journal decision: re-root, don't rewrite

The journal (`journal.mjs`) is "memory = files in a folder," but the folder is hidden (`~/.blitzos/fs`), relay-unreachable, and global. The workspace folder is a strict superset. **Decision: re-root the existing `/fs`-backed verbs from `~/.blitzos/fs` to the active workspace folder — a path reassignment, not a rewrite.** Memory-via-files ships immediately, for both local and relay agents.

- **`shFs` (the shell-string parser) is deleted** — a liability over any untrusted transport, redundant on trusted paths. Only structured file verbs survive.
- The path-escape jail in `resolvePath` is **replaced with a realpath-based jail** (§9) — the current string check is insufficient (confirmed: `journal.mjs` jail is string-only, no realpath/symlink defense).
- **Relay (remote) agents** get structured verbs `workspace_read/write/list/mv` over the relay, jailed to the workspace root (the only file-shaped API that survives). Co-located agents bypass it and touch disk.

### 6.4 The file-vs-API boundary

**Stays an API (no file form):** `surface_control` (click/type/key/read/screenshot inside a live web surface), `read_window` (live DOM, consent-gated), `events` (the perception long-poll), the `window.blitz` integration data bridge. **Demoted to convenience over files:** `create_surface`/`open_window`/`move_surface`/`update_surface`/`close_surface` (shortcuts that do the file write). **`list_state` becomes a merge of folder layout ⊕ live runtime** (loaded?, live title, webContentsId) — not a pure folder projection, because the agent needs liveness the folder cannot hold.

---

## 7. Browser session / login

**Decision: keep ONE global browser profile in v1** (today's `persist:agentos` partition / `.blitz-chrome-profile`), **outside every workspace.** A `.weblink` carries only a URL; the session lives in the profile. **[resolves: security-critic — a synced/committed/backed-up folder must never contain live cookies; the per-workspace open question is deferred.]**

Portability falls out: copy/git/sync a workspace and you carry intent ("open gmail.com"), never credentials. The recipient is logged out until they log in once.

Named identity profiles (Chrome-people / Firefox-containers model: a `.weblink` references a profile *name*; agent-opened/untrusted URLs default to an **ephemeral, cookie-isolated** profile so `attacker.com` can't ride your Gmail cookies) are a **real feature, deferred to "later."** Meanwhile agent-opened-web still gets `shared:true` for perception, but that is read-consent, not cross-site cookie access. The flush machinery (`persistence.ts` 20s cadence + the `before-quit` about:blank-unload Discord trick) is kept verbatim — correct and orthogonal.

---

## 8. Server-mode + multi-tenant mapping

The same model, hosted. A **thin module boundary** (not a ceremonious `WorkspaceFS` interface with CAS/etag/watch verbs) wraps file I/O so the local-fs path is the only one built now; extract the real interface from two working implementations when server-mode exists.

- **Single-operator box:** the same local-fs path, rooted at `$BLITZ_DATA/<tenant>/<workspace>/`. The agent runs on the box → real fs access → the §6 ideal, fully realized.
- **Watching, hosted:** never inotify. **Poll the small `.blitzos/` change-feed**, and have writers signal reconcile directly (over the existing SSE channel). Idle tenants cost nothing.
- **Multi-tenant boundary = one container per tenant**, workspace as a bind-mounted volume, unprivileged process. That is the real isolation; the path jail (§9) is defense-in-depth.
- **R2/D1 backing, git-clone-on-object-store, two-object CAS — deferred.** When built, layout becomes one D1 row-set per workspace (boot = one `SELECT`) and content blobs are R2 objects loaded lazily. The "one layout file" model already collapses to "one row-set," which is the right cloud access pattern.

`mode` defaults to `canvas` server-side, `desktop` in Electron.

---

## 9. Security model — the must-not-break invariants

1. **The jail is realpath-based, not string-based.** Every `read`/`write`/`list` resolves the final path *and every intermediate component* via `realpath` and rejects anything not under `realpath(root)`. `list` treats symlinks as opaque, non-traversed. `git clone` runs with `core.symlinks=false`, `--depth=1`, `core.hooksPath=/dev/null`, and file-count/size/time caps. **[resolves: security-critic FATAL — the string `startsWith` jail in `journal.mjs` is replaced; a relative symlink with no `..` can no longer reach `integrations.json`/cookies.]**
2. **No secret is ever on a workspace-reachable path.** OAuth tokens, browser cookie profiles, and relay/localhost tokens live outside every workspace root and outside anything a workspace could symlink into.
3. **Content-share / consent is session-scoped, in-memory, never in a file.** Stays the in-memory Set the renderer controls — can't be forged by an agent file-write, can't travel in git, never touches the P0 confused-deputy gate (srcdoc ids stay server-minted). **"Consent survives restart" is judged a misfeature:** a user who shared a banking tab yesterday should re-grant today. If ever wanted, it goes in machine-local, gitignored, agent-read-denied `.blitzos/state/` — never in a node entry.
4. **`.blitzos/state/` is agent-read-denied.** The jail carves it out as a deny-list inside the root; the agent's file verbs cannot read chat/activity/consent/locks.
5. **The `app` iframe drops `allow-same-origin`.** `allow-scripts allow-same-origin` together is a sandbox escape (confirmed present in `SurfaceFrame.tsx`); untrusted framed content gets `allow-scripts` only.
6. **`.widget` bundles and imported workspaces are quarantined.** A workspace not created on this machine requires an explicit "trust this workspace's widgets" gate (Gatekeeper model) before any bundle executes; any persisted-grant-class state from elsewhere is void.
7. **Snapshot never `git add -A`.** The snapshot action stages an explicit allow-list (content + `workspace.json`), never `state/`, profiles, or tokens, and refuses anything matching a credential denylist even if `.gitignore` is missing.
8. **The localhost token is tightened.** Required on every route (incl. `workspace_*`), kept out of stdout and out of a world-readable flat file (0600 / Keychain), guarded against DNS-rebinding via a `Sec-Fetch-Site`/custom-header check.
9. **`path` fields are jail-validated, the workspace registry is OS-write-only, and "open workspace at path P" from any agent path is denied or human-confirmed** (never auto-open `$HOME`/`/`).

---

## 10. KEEP / REWRITE / REMOVE

| Code | Disposition | What changes |
|---|---|---|
| `src/renderer/src/store.ts` | **REWRITE** | Becomes a projection: `hydrate(ws, files)` load path; write-through to `workspace.json` via a main-side diff subscriber; ULID ids (drop `srf-${zCounter}` as identity — keep `zCounter` only as a session render allocator); `stack[]` replaces per-node `z`-bump; `layoutHistory` stays in-memory (undo is ephemeral). |
| `src/renderer/src/types.ts` (`Surface`) | **REWRITE** | Split into **content** (file), **durable** (node entry: id/path/kind/x/y/w/h/zoom/view), **live runtime** (webContentsId, loaded, live title — never serialized). Dissolve `props`. |
| `src/main/osActions.ts` | **REWRITE** | Tool fns become thin write-through wrappers; `osGetState`/`list_state` = `workspace.json` ⊕ live runtime; stable ULIDs. |
| `src/main/journal.mjs` | **REWRITE (re-root)** | `ROOT` → active workspace folder; **delete `shFs`**; replace `resolvePath` with the realpath jail. Verbs survive as the relay `workspace_*` bridge + local convenience. |
| `src/main/control-server.ts` | **REWRITE** | `/fs`,`/sh` → `/workspace_*` over the re-rooted jail; token required on every route + `Sec-Fetch` guard; token off stdout/flat-file. |
| `src/main/widget-catalog.mjs` | **REWRITE (small)** | Make the `.html` write atomic (temp+rename). Builtin/authored + `origin` model maps to `view.origin`. |
| `src/main/perception-core.mjs` | **KEEP** | Untouched. Content-agnostic; `isContentShared` stays an in-memory Set (§9.3). |
| `src/main/persistence.ts` | **KEEP (extend)** | Login flush / `before-quit` unload trick kept verbatim; add one `await flushPendingLayout()` to the existing quit hook. |
| `preview/browser-host.mjs` | **KEEP** | One global profile in v1; Discord on-unload flush + singleton-lock cleanup unchanged. |
| `preview/backend.mjs` | **REWRITE** | Add the workspace module + reconcile; `/api/os/state` POST → translate deltas to `workspace.json` writes; SSE `hydrate` on connect; `workspace_*` over the jail; tenant scope from session, never body. |
| `src/renderer/.../SurfaceFrame.tsx` | **REWRITE (2 lines)** | `app` iframe drops `allow-same-origin` (§9.5); `partition` stays `persist:agentos`. |
| `src/main/blitzos-agents.md` | **REWRITE** | Drop the journal teaching; teach "the workspace is a folder, edit files, memory = the folder"; point at `BLITZOS.md`; demote canvas tools to convenience. |
| `src/main/sessionFile.ts` | **KEEP** | Discovery, not workspace content. Untouched. |
| Per-item meta mirror, three-way merge, CAS, conflict-copies, echo ledger, `.group`, `.app`/`.applink`, kind registry, `.blitzos/.lock` heartbeat, per-workspace profile, consent-in-file, schema migration ladder | **REMOVE / never build (v1)** | Cut per the critics; see §11 "later" for what graduates. |

---

## 11. Migration / build order

A **lean v1** that ships the whole vision, then a clearly-marked path to the rest. Each phase is independently verifiable headlessly (control API + `list_state` + reading the folder).

**Phase 0 — stable ids.** Replace `srf-${zCounter}` identity with ULIDs threaded through the node entry. No persistence yet. Smallest, safest unblocker.

**Phase 1 — write-only.** Main-side diff subscriber + atomic `workspace.json` writer + content-file writers. Arrange surfaces, watch the file fill correctly. Store still inits empty — zero risk to the running app.

**Phase 2 — hydrate + re-root the journal.** Boot reconcile/load path + `hydrating` guard → restart restores the canvas. Re-root the journal verbs, delete `shFs`, install the realpath jail, author `BLITZOS.md`, rewrite `blitzos-agents.md`. Memory = workspace files, for local and relay agents.

**Phase 3 — the watcher + reconcile.** Doorbell watch + 250ms-coalesced idempotent reconcile + 500ms self-write window. External edits reflect; rename heals; auto-place works. (No merge engine to build — small phase.)

**Phase 4 — runtime split + security hardening.** Chat/activity → `state/*.jsonl`; `app` iframe `allow-same-origin` drop; `.blitzos/state/` agent-read-deny; snapshot allow-list; localhost token tightening; widget/import quarantine.

**Phase 5 — server-mode parity.** Wire the thin fs boundary into `backend.mjs`; SSE hydrate; poll-based reconcile (never inotify); deltas → `workspace.json`.

**Graduates to "later" (real features, real triggers — not YAGNI):**
- **Per-item metas / D1 row-set** — *trigger:* a real workspace measurably hurts on whole-file `workspace.json` rewrites (hundreds of nodes). The aggregate is the source of truth; per-node files would be a derived export.
- **Named identity browser profiles + ephemeral isolation for agent-opened URLs** — closes the one-global-jar limitation (§7).
- **`.group` as a pure-UI layer** — no new persistence concept.
- **Multi-tenant R2/D1 backend, container-per-tenant, two-object CAS, git-clone-on-object-store.**
- **Single-instance heartbeat lock** — *trigger:* two-instance corruption is actually observed; v1 ships at most a "may be open elsewhere — continue?" dialog.
- **Schema migration ladder** — when v2 exists.

---

## 12. Open decisions (the real forks for the user to call)

1. **Is `.blitzos/workspace.json` committed to git, or gitignored?** This spec gitignores `.blitzos/state/` always, and leaves `workspace.json` **committed by default** (layout is part of the artifact — "your spatial arrangement clones with the repo"). The alternative (gitignore all of `.blitzos/`) makes a clone a random pile of auto-placed nodes. The `stack`-array + no-`updatedAt` design keeps committed layout git-quiet; recommend **committed** — flip it if clones should never carry layout.
2. **Default workspace location & first-run.** Assumed `~/Blitz/<name>/` with a `Home` default and an "Open Folder" action. Confirm the root and whether first-run auto-creates `Home` or prompts.
3. **`_`-prefixed agent scratch — convention or enforced?** This spec treats agent memory as ordinary visible notes (`_context.md` is a naming convention, fully visible on canvas). A hidden agent scratch needs a `.scratch/` plain-folder convention (doesn't auto-surface) — a small UX call.
4. **Does content-share consent *ever* persist?** Spec says **no** in v1 (session-scoped, safest). If product wants "shares survive restart," it goes in agent-read-denied machine-local `state/` keyed by ULID — confirm before the identity-profiles milestone, since it touches the security boundary.
5. **Activity feed: truly ephemeral, or persisted?** Made best-effort (may start empty on restart). If it's durable history, it needs the same persistence + eventual rotation as chat.
