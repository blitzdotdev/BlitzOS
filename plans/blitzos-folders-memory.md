# BlitzOS: folders, memory, and the connector skill (under workspaces)

**Status:** Decisions made 2026-06-06 (coordinate/defer the file-verbs + Electron persistence; test in Electron). **Phase 1 BUILT** (typecheck clean): runtime Notepad note (Electron, per-session), connector-skill fix (journal -> Notepad), doc Memory section. Key discovery: `read_surface` is unneeded, `list_state` already carries note `props.text`, so the Notepad is agent-readable/writable today. **Deferred (coordinated):** Phase 2 folder->subfolder serializer; Phase 3 Electron persistence + disk file-verbs (these make the Notepad persist + the folders persist).
**Date:** 2026-06-06
**Parent/related:** `agent-os-workspaces.md` (master's persistence spec, the governing design); `plans/agent-os-window-management.md`.
**Code in scope:** `src/main/workspace.mjs`, `src/renderer/src/store.ts`, `components/Folder*`/`SurfacePreview`, `src/main/blitzos-agents.md`, `~/.claude/skills/blitzos/SKILL.md`, `preview/backend.mjs`, and (new) relay/localhost file verbs in `agentSocket.ts`/`control-server.ts`.

---

## 0. Conform to master's spec, do not invent

All three asks are already decided in `agent-os-workspaces.md`, so we conform:
- **Grouping = a plain subfolder = a collapsed tile** (§4): "grouping = drop into a plain folder = `mv` into it." `.group` is explicitly cut; the iPhone expand/preview is "a pure-UI layer needing no new persistence concept" (§4, §12). So our folder serializes as a `folder` node (a real subdir); FolderWidget/Overlay is that UI layer.
- **Memory = notes in the workspace** (§6.2, §6.3, §12): "your memory IS this workspace, keep notes as `_context.md`." The default notepad is master's intended memory mechanism, surfaced as a `note`.
- **Skill:** the journal `/fs` is gone (master deleted `journal.mjs`); the connector must stop recovering via it.

## 1. Two realities this design must respect

- **R1 (persistence is server-only today).** `writeWorkspace`/`readWorkspace`/`reconcileWorkspace` are called only from `preview/backend.mjs` (`WORKSPACE_DIR`); Electron `main` does not call them. So serializer-level work persists in **server mode now** and in Electron only once Electron is wired (master's "later"). Anything we build in the shared `workspace.mjs` is paradigm-correct and future-proof, but will not persist in the Electron app the user usually runs until that wiring exists.
- **R2 (a relay agent currently cannot READ memory).** The agent can WRITE a note (`update_surface { id, props:{text} }`), but **no tool returns a note's/file's content**: `list_state` carries no text, `read_window`/`surface_control` are web-only. The journal `/fs` that used to provide this is deleted. So a notepad is inert for the agent until a read path exists. The spec plans this as re-rooted `workspace_*` file verbs (§6.3/§6.4); it is not built.

## 2. Coordination risk (the most important call)

Master is **actively building workspaces in phases** (the spec is their live roadmap). Several pieces of "do it properly" are explicitly **master's planned work**:
- Re-rooting the journal verbs to the workspace as `workspace_*` (§6.3, §11 Phase 2).
- Electron-main persistence wiring (§11).
- The folder "pure-UI layer" itself (§4, §12 "later").

If we build these independently, we duplicate the collaborator's in-flight work and create the next merge conflict. So this plan separates **clearly-ours, low-conflict** pieces (do now) from **master-roadmap** pieces (coordinate / explicitly own before building). Decide ownership per piece in §6.

## 3. Piece A — Folders as subfolders (persisted grouping)

**Target:** a group is a real subdirectory; on the canvas it is one collapsed `folder` tile; opening it shows the members; ungrouping `mv`s a member back to the root. Our `FolderWidget`/`FolderOverlay` becomes the UI over this, with **no** parallel `props.members`-of-ids persistence.

**Serializer (`workspace.mjs`), the core change:**
- `nodeKind(s)`: add `native + component:'folder' -> 'folder'`.
- Write path: a folder surface -> a real subdir; each member (surface with `groupId === folder.id`) writes its content file **inside** that subdir, not at root. The folder node entry is `{ id, path:<subdir>, kind:'folder', x,y,w,h, view:{ title } }` with **no content file**. Members are NOT root `nodes[]` (off-canvas, per spec) while collapsed.
- Read/hydrate: a `folder` node (or a plain subdir found on reconcile) -> a collapsed `folder` surface. Members are the files in the subdir, materialized only when the folder is opened (see the fork below).
- `reconcile`: detect plain subdirs (today `autoKind` only handles loose `.md`/`.weblink` files; dirs are skipped) and surface them as folder tiles; honor the spec's "no recursive watch / contents off-canvas" so a cloned repo is one tile, not N nodes.

**Store + UI changes:**
- `group(ids, name, ...)`: keep the gesture, but its meaning becomes "these members belong to folder F"; the **main-side serializer** does the disk `mv`. The store no longer needs `props.members` as the durable source; members are derived from `groupId` (live) and the subdir (durable).
- `FolderWidget` (collapsed): icon + name + count, plus up to N static thumbnails. `FolderOverlay` (open): read the subdir, materialize members transiently, lay them out, `mv` back on pop-out (`ungroupOne`).

**Fork F1 (preview model):** (a) keep live member previews when collapsed (materialize hidden member surfaces, cap N, fall back to icon+count for big/repo dirs); or (b) collapsed = icon + count + static thumbnails only, materialize members only on open. **Recommendation: (b)** — it matches the spec's "contents off-canvas, a repo is one node not 5000" and scales; our overlay still gives the rich expand. (a) is prettier for small groups but reintroduces the per-member-surface cost the spec cut.

## 4. Piece B — Default notepad (workspace memory)

**Target:** every workspace ships a notepad note the human and agent both read/write; it persists as a file; it is the memory mechanism that replaces the journal.

- **Scaffold:** in `workspace.mjs` `scaffold(dir)` (which already writes `BLITZOS.md` + `.gitignore`), also write `_context.md` once, with a short starter ("BlitzOS working memory. The agent keeps context here; you can edit it too."). `autoKind` already maps `.md -> note`, so it auto-surfaces as a `note` on hydrate/reconcile. Human r/w is the existing `NoteWidget`.
- **The agent read/write path (depends on R2).** Writing works today (`update_surface props.text`). Reading does not. Options in §5 piece D.
- **Doc:** in `blitzos-agents.md`, replace the deleted journal section with "Memory: your durable memory is `_context.md` in the workspace (a note on the canvas). Read it on connect, keep it current; the human reads/edits it too." Naming/visibility per fork F2.

**Fork F2 (notepad identity):** `_context.md` titled "Context"/"Notepad", **visible on the canvas** (spec's default, the human can see/edit it) vs a hidden `.scratch/` agent-only file (spec §12 open decision #3). **Recommendation: visible `_context.md`** — the user explicitly wants the human to r/w it.

## 5. Pieces C + D — the skill, and the missing read path

**Piece C — connector skill (`SKILL.md`), clearly ours, low-conflict, do now:**
- Remove the journal-recovery step (`fs fs cat journal/mandate.md` etc., now dead).
- New recover-context step: read the workspace memory. If the workspace file verbs exist (piece D), `cat _context.md`; otherwise note that memory-read is not yet available over the relay and the agent should rely on `list_state` + the human.
- Keep the connect bootstrap and the `/events` waker (unchanged by workspaces).

**Piece D — the workspace file verbs (the unlock for B and the relay), master-roadmap:**
- Per spec §6.3/§6.4: re-root the old journal verbs to the active workspace folder and expose `workspace_*` (ls/cat/write/append) over the relay + localhost, with the realpath jail (§9). This is the single mechanism that lets the agent READ `_context.md` (and later browse folder contents) over the relay.
- This is explicitly master's Phase 2. **Building it ourselves risks colliding with the collaborator.** Decide ownership in §6.

## 6. Open decisions / forks (need your call before building)

1. **Ownership vs coordination.** Pieces D (workspace file verbs) and Electron-persistence wiring are master's planned phases. Do we (a) build them ourselves now (fastest, but likely conflicts with the collaborator's next push), (b) ask the collaborator's status and slot in, or (c) do only the clearly-ours pieces (folder UI over the serializer, notepad scaffold, skill) and depend on master for D? **Recommendation: (c)** for D + Electron; **build A (folders) + B-scaffold + C (skill) now.**
2. **F1 preview model:** icon+count+materialize-on-open (recommended) vs live previews.
3. **F2 notepad identity:** visible `_context.md` (recommended) vs hidden scratch.
4. **Persistence target:** do we also wire Electron-main persistence now so this is visible in the app you run, or stay server-mode-only for now (master's sequence)? Without it, folders/notepad persist in server mode only. **Recommendation: confirm which mode you will test in;** if Electron, we need the wiring (coordinate per #1).

## 7. Build order (once forks are settled)

- **Phase 1 (clearly ours):** notepad scaffold (`_context.md`) + `blitzos-agents.md` memory section + `SKILL.md` update. Smallest, unblocks "memory exists as a surface." (Agent-read still pending D.)
- **Phase 2 (folders):** serializer `folder` node (write/read/reconcile) + store/`FolderWidget`/`FolderOverlay` over the subdir model. Verifiable in server mode.
- **Phase 3 (coordinated):** workspace file verbs (D) + Electron persistence, owned per #1. Unlocks agent-read of memory and persistence in the Electron app.
