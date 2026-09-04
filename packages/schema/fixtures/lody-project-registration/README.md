# Lody local-project registration (`/project-control`)

The `local-project/*` requests BlitzOS authors, and the daemon's answers to them.

At HEAD the box still installs the transition `lody@0.88.1` npm artifact and
its compiled patches until plan PR C; the target daemon is built from
`vendor/lody`. The recapture rule and upstream procedure are in
`docs/LODY-MERGE.md`.

## Why this is a BlitzOS contract

Phase 5 made a box register each `/workspace/<repo>` clone as a Lody local
project (`plans/LODY-SESSIONS.md` §6.4), because a worktree session is cut off a
project the daemon already knows. Two BlitzOS-authored producers now build these
payloads:

| Side | Code | What it authors |
|---|---|---|
| box (node) | `packages/box/rootfs/usr/local/libexec/blitz-lody-projects` | `local-project/list` and `local-project/add`, once per pass, over the daemon's unix control socket |
| browser | `packages/webapp/src/lody/local-bridge.ts` (`projectResult`) and `rpc-client.ts` (`sendProjectControl`) | every `local-project/*` and `worktree/*` request the vendored renderer asks for, through `/lody/project` |
| browser | `packages/webapp/src/lody/local-projects.ts` (`registerWorkspaceRepositories`) | `local-project/browse-dir` and `local-project/add`, once per surface mount: the same registration the box does, driven from the tab |
| daemon (node) | transition image: npm artifact until plan PR C; target source: `vendor/lody/apps/cli` | reads both and answers |

That is a payload crossing a runtime boundary with a BlitzOS author on two
sides, so CLAUDE.md's cross-runtime rule applies. It is the same arrangement
`fixtures/lody-data-plane/` records for the sync plane.

The SCHEMA stays Lody's: `vendor/lody/packages/shared/src/message-schemas.ts`
(`LocalProjectControlRequestSchema`, `LocalProjectControlResponseSchema`) is the
source of truth, and both conformance tests validate against it rather than
against a copy. What this corpus pins is that our two producers keep agreeing
with it, and with each other, across an upstream merge.

## Provenance

Every file under `response/` was **captured from a real `lody@0.88.1` daemon**
on 2026-08-30 (`browse-dir-*`, `list-roots-home` on 2026-08-31), running the
box's own patched bundle
(`packages/box/patches/lody-local-platform.mjs`) in local platform mode, against
a scratch clone whose `origin` is a GitHub HTTPS URL. The ids are the ones that
daemon minted; nothing is hand-written.

`request/` is what `blitz-lody-projects` sends, recorded from the same run.

When a reviewed semantic change requires recapture, replace the historical
sentence above with: “Captured from the daemon built from `vendor/lody` at
`<upstreamSha>` (`distSha256` `<sha>`).” Use real stamp values.

## What each file is FOR

- `request/list.json` — the first call of every pass. Its answer is what keeps a
  reboot quiet: already-registered roots are skipped rather than re-added.
- `request/add.json` — note what is NOT in it. `LocalProjectAddRequestSchema` is
  `.strict()` and has no `githubRepoFullName` field; §6.4's "set
  `ProjectRef.githubRepoFullName` so the sidebar groups these under GitHub
  Worktrees" is satisfied by the DAEMON deriving it from the clone's remote and
  reporting it on `local-project/git-state`. A registrar that tried to send it
  would get a 400.
- `response/list-empty.json` — a daemon that has never seen a project answers
  `{ workspaces: [] }`, not a workspace with an empty `projects` array. A reader
  that assumed the latter would crash on first boot, which is every box.
- `response/add.json` / `response/add-repeat.json` — **the idempotency
  evidence.** Adding the same `rootPath` twice returns the SAME
  `localProjectId`, which is why re-registration on every reboot cannot
  duplicate a project. The registrar's list pass is an optimization on top of
  this, never the safety.
- `response/list-one-project.json` — the shape the registrar diffs against.
- `response/add-refused-path-invalid.json` — the error envelope
  (`ok: false`, `error: 'path_invalid'`). A refusal is logged and the pass
  continues; one bad directory must not stop the others being registered.
- `response/platform-catalog.json` — where the `machineId` in every request
  above comes from. The browser has no other source: the positional
  `localProjects.*` helpers Electron defines take no machineId (their main
  process IS the machine), so `local-bridge.ts` resolves it from `/lody/platform`
  and injects it. Served by the browser conformance test so the recorded ids
  compare against the fixtures.
- `request/list-roots.json` / `response/list-roots-home.json` — **the browse-root
  evidence.** The daemon answers `homeDir` from `os.homedir()`, and on a box that
  is `/var/lib/blitz/home` — the `HOME` its s6 service sets. The "Add a local
  project" folder browser opens there
  (`use-remote-directory-picker.ts:241` is the field's only reader), which is a
  directory holding none of the member's repositories. `withBoxBrowseRoot` in
  `local-bridge.ts` answers `/workspace` instead, on the way back through the
  seam; the daemon's own answer is left alone, because `HOME` is also where it
  keeps its data dir and its agent credentials.
- `request/browse-dir.json` / `request/browse-dir-page2.json` — what the
  browser-side sweep sends: the workspace root, then the cursor the previous
  page handed back.
- `response/browse-dir-page1.json` / `-page2.json` — **the worktree evidence.**
  `alpha` carries a `.git` DIRECTORY and `beta` a `.git` FILE (`gitdir: …`, what
  a git worktree checkout has); the daemon hints `git: true` for BOTH, because
  the hint is `.git` existing and not `.git` being a directory
  (`local-project-control-service.ts:352`). `notes` is a plain directory and
  carries no hints; the `.hidden` directory beside them is not in either page,
  because `showHidden` defaults off. Page 1 is `truncated` with a `nextCursor`,
  page 2 is not — the pair is what pins the sweep's paging.
- `response/browse-dir-registered.json` — the same first page after `alpha` has
  been added. `registeredProjectId` is what the sweep skips on, so a repo the
  box registrar reached first costs no second `local-project/add`.
- `response/git-state-github-remote.json` — the answer §6.4 depends on:
  `githubRepoFullName` derived from the clone's `origin`, the branch list the
  landing's branch picker renders, and the working-tree flags the dirty badge
  reads.

## Conformance

- Box: `packages/box/guest-tests/test/lody-projects-registration.test.ts`
  (runs the real registrar against a stand-in daemon socket)
- Browser: `packages/webapp/test/lody-project-control-frames.test.ts`
  (frames, the sweep, and the browse-root override)
