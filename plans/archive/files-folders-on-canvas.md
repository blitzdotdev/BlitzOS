# Files & folders on the canvas (#37) — design

**Status:** design (2026-06-07). The unbuilt half of the workspace vision (transcript msgs 95–101).
The workspace IS a folder; today only `.md`/`.weblink`/`.html` surface as nodes. #37 makes the
folder's REAL files and subfolders appear on the canvas as draggable tiles, in both modes.

## Model (what the user sees ↔ what's on disk)

A workspace folder's loose entries each become a canvas node:

| On disk | Canvas node | Kind |
|---|---|---|
| `*.md` | note (editable post-it) | native `note` (exists) |
| `*.weblink` `{url}` | web window | `web` (exists) |
| `*.html` | agent-authored panel | `srcdoc` (exists) |
| `*.png/.jpg/.gif/.webp/.svg` | image tile (shows the image) | native `file` (img) — NEW |
| `*.pdf` and any other file | file tile (icon + name + size) | native `file` — NEW |
| a **subfolder** | folder tile | native `folder` (real dir) — NEW behavior |

Layout stays in the ONE `.blitzos/workspace.json` (the 14-agent brainstorm rejected per-item sidecar
metas — keep central). Content = the file itself. No new metadata files.

## The two folder kinds (msg 100)

- **Plain folder** (default) — a COLLAPSED tile. Its contents are NOT spread on the canvas (so a
  cloned git repo is one tile, not thousands of nodes). Double-click → opens it as the active
  workspace view scoped to that subfolder (a "drill-in"), or reveals its contents in a folder
  overlay (like the existing iPhone-folder overlay, but backed by the real dir). This is grouping +
  repos.
- **Special `.app`-like folder** — contents ARE laid out on the canvas as a nested sub-board (its own
  `.blitzos/workspace.json` inside). Opt-in: a folder named `*.board` (or marked in workspace.json).
  This is the "folder that can have subitems on the canvas." v2 — start with plain folders.

The existing iPhone-style `folder` (component `folder`, props.members = surface ids) is a RENDERER
grouping. Reconcile its semantics with a real subfolder: **grouping moves the members' files into a
real subfolder** (BLITZOS.md already says "group → move files into a subfolder"). So an iPhone-folder
== a real subfolder whose members are the files inside. Unify them so the on-disk + on-canvas folder
are the same object (avoids the two-folder-concepts drift).

## Backend (`workspace.mjs`)

- `autoKind(name)` → also classify images + arbitrary files as `file`, and (new path) dirents that
  are directories as `folder`. Keep skipping dotfiles/.blitzos/temp/meta.
- `nodeToSurface` → materialize `kind:'file'` (native `file`, props: `{ ext, bytes, src? }`; for
  images, a `blitz-file://` URL the renderer can show) and `kind:'folder'` (native `folder` real-dir,
  props: `{ entries: n }` count + a peek list).
- `contentFor`/`writeWorkspace` → a `file` node's content is the file as-is (no rewrite — `writeIfChanged`
  must NOT touch binaries; only persist its node x/y/w/h in workspace.json). A `folder` node persists
  as a real subdir; moving files in = grouping.
- `reconcileWorkspace` → surface NEW loose files AND subfolders (currently only `.isFile()` +
  md/weblink). Auto-place them; drop nodes whose file/dir vanished.
- Image bytes to the renderer: a `blitz-file://` protocol (Electron) / a `/api/os/file?path=` route
  (server), jailed to the workspace dir (realpath, no traversal — Phase-4 security applies here).

## Renderer

- New native component **`file`** (`FileWidget`): an icon chosen by extension (img preview for images,
  a doc/zip/code glyph otherwise) + filename + size. Double-click → open (img inline already; pdf →
  a `web` surface of the file URL; text → a note; else → reveal/download). Draggable + resizable +
  snappable like any surface (free, from the work just shipped).
- **Folder** tile for real dirs (extend the existing `folder` component or a `dir` variant): shows the
  folder name + entry count; double-click → drill-in / overlay of contents.
- Drag-drop IN: drop OS files onto the canvas → copy into the workspace folder at the drop point →
  reconcile surfaces them. (Electron: `webContents` file drop → main copies; server: an upload route.)
  v1 may defer OS drag-in and rely on files already in the folder + the agent writing them.

## Build order

1. Backend file-surfacing: `autoKind`/`nodeToSurface`/`reconcile` for `file` + image, + the jailed
   file-bytes route/protocol. (No renderer dependency to TEST the node output.)
2. `FileWidget` (icon/img/name) + wire `native 'file'` in SurfaceFrame; verify a dropped-in file
   appears as a tile (headless: write a file into the workspace, reconcile, see the node).
3. Real-folder tiles + drill-in (plain folder = collapsed; contents on demand).
4. OS drag-drop in (+ drag-out later).
5. The `.app`-like canvas-subitem folder (nested sub-board) — v2.

## Open decisions (proposing defaults; will confirm with the user)

- **Drill-in vs overlay** for opening a plain folder → default: overlay (reuse FolderOverlay) for v1;
  drill-in (scoped workspace view) is nicer but bigger.
- **Unify iPhone-folder with real subfolder now, or keep separate for v1?** → default: keep the
  iPhone-folder as-is for v1 (renderer grouping), add real-dir tiles as a separate `folder` real-dir
  node; unify in a follow-up to avoid destabilizing the persistence model mid-stream.
- **Open-handlers** (pdf→web, text→note, etc.) — default the above; refine per the user.
