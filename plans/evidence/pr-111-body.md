# Lody sessions: chats and GitHub worktrees, first-class

> **Historical pull-request record.** As of 2026-09-04, its npm-daemon,
> verified-pair, compiled-patch, and merge-procedure descriptions are superseded
> by `docs/LODY-MERGE.md` and `plans/LODY-DAEMON-FROM-TREE.md`.

Vendors Lody's session plane into BlitzOS: the daemon on the box, the renderer
in the webapp, and the rail rebuilt around sessions instead of terminal tabs.
Phases 0–7 of `plans/LODY-SESSIONS.md`, which is the plan and the record.

**Everything here is DARK.** The webapp half is behind
`VITE_BLITZ_LODY_SESSIONS` and the box half behind `BLITZ_LODY_SESSIONS`, both
off. No image has been baked and nothing is deployed. `plans/LODY-SESSIONS.md`
§13 is the checklist for the rest, and it needs a human with credentials.

355 files outside `vendor/`, +32.9k/−14.1k. 10.5k of the deletions are the
surface this replaces.

---

## What lands

### The legacy chat surface is deleted, first

BlitzOS carried a browser ACP client and a box actor on port 7444 — a SQLite
session journal, a replay path, permission fan-out — dormant behind
`NATIVE_CHAT_ENABLED = false` since it was written. All of it is gone: the
client, the actor, the journal, the `chat` tab type, the recipe `chat` harness,
the bootstrap prompt sender and the ACP fixture corpus. Retirement happened
FIRST rather than last, so the daemon arrives on empty ground and no member ever
had two chat surfaces.

Port 7444 stays reserved in every list, because boxes already in the field still
run the old actor. A stored `type: 'chat'` tab is dropped on read on both sides,
so an old shared document still parses.

### `vendor/lody`, and a divergence of seven files

A squashed `git subtree` of [LodyAI/Lody](https://github.com/LodyAI/Lody)
(Apache-2.0), pinned in `vendor/lody/UPSTREAM.md`. The renderer is built from
that source; the daemon is installed from npm at a pinned version, and the two
move together.

**Nothing in it is edited except at a declared seam**, and every seam is in
`vendor/lody/BLITZ-PATCHES.md` with its upstream anchor, its reason, and a merge
conflict drill. Four seam patches, seven files, all strictly additive — with the
props absent, every upstream call site renders byte-for-byte what it did before:

| # | Idea | Files |
|---|---|---|
| 1 | a non-Electron local bridge may serve the local planes | `workspace-machine-rpc-facade.ts`, `create-workspace-runtime.ts`, `window-globals.d.ts` |
| 2 | `LoroSidebar` can suppress its own header and footer | `loro-sidebar.tsx` |
| 3 | the local attachment fast path is not Electron-only | `electron-session-file-sender.ts` |
| 4 | a session surface can be followed without being driven | `session-chat-interface.tsx`, `session-detail.tsx` |

**Three of the four delete when their upstream PR lands**, and all three PRs are
drafted in `plans/evidence/`. None has been submitted — that is a decision for a
person, and it is on the list below.

Everything else BlitzOS-specific lives in `packages/webapp/src/lody/`, outside
the vendor tree, including three workarounds for upstream defects that each have
a named upstream fix and delete when it lands.

### The box: a daemon, a bridge, and one new gateway surface

`lody` is installed in the image beside `claude` and `codex`, with its data dir
on the state volume so it survives VM replacement. Three s6 services: the
daemon, `blitz-lody-bridge`, and `blitz-lody-projects`, which registers every
git repository under `/workspace` every 30 seconds.

The bridge is the browser's door into the daemon. The daemon speaks only over
unix sockets; the bridge re-serves exactly five of its surfaces on one socket
the Go gateway reverse-proxies: `/lody/{sync,rpc,control,project,platform}`.
Those five are in `webapp-surface.ts` and `gateway/main.go` with drift tests on
both sides.

The published `lody` npm package is the CLOUD build — its Vite config inlines
the platform as a literal, so the local composition root is unreachable and the
daemon blocks on a device-authorization login. The now-retired `lody-local-platform.mjs`
restores the env read at image build, guarded by a sha256 of the input and an
anchor count, so a version bump fails the image build loudly rather than
shipping a box that cannot start.

### The runtime, and one measured surprise per phase

`packages/webapp/src/lody/` assembles their workspace runtime against the box:
a platform provider with an empty capability set, an inert auth client, an i18n
instance with `keySeparator: false`, and a data plane that speaks their protocol
v7 over a WebSocket instead of Electron IPC. `plans/LODY-RUNTIME-DESIGN.md`
§7–§11 records what each phase measured to be wrong about this, in the same
form each time: what the document said, what shipped, and why. Nine such
findings in phase 2, nine more in phase 3.

### The surface and the rail

`SessionSurface` mounts their chat landing and their session detail inside our
shell, under a memory router, with their pages unmodified — every send, steer,
cancel and permission path is their code. The rail's list region is their own
`LoroSidebar` body, portalled in, with our Terminals section injected through
their `afterSessionListContent` slot.

The active chat selection is an ADDRESS and nothing else:
`/workspaces/:id`, `/workspaces/:id/chat`, `/workspaces/:id/chat/:id`.
`webapp_state` learns nothing about chat sessions, because the daemon's list is
what exists and a stored id in a document shared across a workspace would point
half its members at a session archived on somebody else's box.

### Worktrees

A worktree session runs on `lody/<id12>` under the daemon's own repo directory,
cut off the `/workspace/<repo>` clone, with the clone's HEAD and index
untouched. Archive commits dirty work as a backup and keeps the branch. Diff
stats reach the rail row as a badge.

Nine of the ten composer controls in §0's acceptance bar passed in phase 5, and
the tenth — attachments — landed in phase 6.

### Sharing

Opt-in, per session, inside a workspace. `plans/LODY-SHARING.md` is the design
and the record.

- **Grants** are D1 rows (migration 0045) with routes on the control plane. The
  control plane keeps NO session list and must not grow one: the daemon on the
  owner's box is the only thing that knows which sessions exist.
- **Routing** is a distinct path prefix,
  `/workspaces/:id/shared/:membershipId/webapp/…`, so a caller who forgets it
  reaches their own box — the safe answer — rather than someone else's.
- **The ticket** grows one recognized claim carrying two disjoint id lists,
  because one grantee can hold read-only on one session and read-write on
  another on the same box. Pinned by a fixture corpus on three runtimes.
- **The gateway** decides where a shared request may go: `/lody/*` and nothing
  else, stated as an allowlist so a surface added later is refused until
  somebody thinks about it.
- **The bridge** decides what it may say: a room ACL on `/sync`, session scoping
  on `/rpc` and `/project`, `/control` refused, `/platform` narrowed. For the
  member who owns the box it is still the phase-1 dumb pipe, byte for byte.
- **The grantee's surface** mounts their session, from their box, in the
  grantee's own browser — read-only without a composer, read-write with one.

Phase 6 refused the `meta` room outright and phase 7 measured what that cost:
`SessionMeta` lives ONLY there, so a grantee refused it has a transcript with no
session around it. The room is now served through a per-document projection,
which turned out to be a JSON filter rather than a CRDT problem — the payload is
a flat `{version, entries}` bundle whose keys are document paths. No CRDT is
parsed and no loro build is needed on the box.

### Attachments

`+` stages the bytes on the box over the existing dufs WebDAV surface and hands
the daemon those paths; the daemon copies them into its own blob store and the
staging files are deleted as soon as the call returns. No new box path, no new
gateway route, no Go change.

### The flag

`VITE_BLITZ_LODY_SESSIONS` in the webapp, `BLITZ_LODY_SESSIONS` on the box; one
name across both halves. With it off, `LodySessionsRegion` renders `null` and
imports nothing at all — the vendored renderer is a 3.5 MB lazy chunk and a test
asserts the entry never names it.

### Automation

`docs/LODY-MERGE.md` is the upstream merge runbook, written so a scheduled agent
can execute it verbatim: the subtree pull's squash-commit caveat, the
verified-pair rule for the npm pin, the platform patch's four sites, the
seven-file seam expectation, the three workaround mirrors and what makes each go
away, the gates, and open-a-PR-never-merge-unattended.

**It has been run for real.** The first merge — `966623d0..f3474894`, eleven
commits — landed in this branch: one conflict, mechanical, resolved by the drill
the conflict manual already carried; the divergence came out at exactly seven
files; all gates green. Four friction points are recorded in that document's own
log, including one that cost a wrong answer (the verification command diffed
against the squash commit, which holds the upstream tree at its own root).

CI gains a Go job for the box gateway, with gofmt. Its suite had been red and
nobody saw it, because CI ran `go test` for `packages/broker` only and the
gateway is compiled by the box-image build, which does not run tests.

---

## What is proven

Every phase's exit tests are in the tree and gate every merge. The daemon-backed
ones skip where no `lody` bundle is installed, which is CI; on a machine that
has one they run a real `lody@0.88.1`, a real bridge and a gateway-shaped front
door.

**Live agent turns spent across the port: nine** — two in phase 3, one in phase
4, three in phase 5, three in phase 7 — each recorded with what it
bought (`LODY-RUNTIME-DESIGN.md` §8.6, §9.5, §10.9; `LODY-SHARING.md` §10.5).
`npm test` never spends one — every dispatch is behind `BLITZ_LODY_LIVE_TURN=1`.

**Not proven, and named rather than implied:** that the daemon acts on a
permission request answered by a non-owner peer. The card renders on a
grantee's mounted surface — seen live, with its real options — and the write
that answers it is proven to land for a read-write claim and to be dropped for a
read-only one. What is missing is the daemon's side of that one write.
`LODY-SHARING.md` §10.5 says exactly what a further turn would buy, and §13.4
puts it on the canary dogfood, where it is free.

Four new or extended cross-runtime contracts carry fixture corpora with
conformance tests on both sides — the webApp ticket (three runtimes now, with
the share claim), the lody data plane, lody project registration, and the lody
share claim — and the box surface list keeps its two-sided drift test. The 64-id
share cap is now one number in the ticket corpus that both verifiers read,
rather than two constants agreeing by a comment.

---

## What still needs a person

1. **Bake the box image.** Nothing else works until an image carrying the
   daemon, the bridge and the new gateway is the pin. Canary and client prod
   share one Hetzner project, so the snapshot id goes into both workflows.
2. **Advertise `webAppSharedSessionsSinceMs`** on `HetznerProvider` and
   `AwsProvider`, with the cutoff set to the moment that image becomes the pin.
   Exact lines in `plans/LODY-SESSIONS.md` §13.2. Sharing is refused everywhere
   until this happens, deliberately.
3. **Flip the flag, box image first**, then the webapp build. Reversed, every
   member sees a rail that cannot list a session.
4. **Dogfood on canary**, following §13.4 — which includes the one live check
   the exit tests could not buy.
5. **Submit the three upstream pull requests.** All drafted, none sent; each
   deletes a seam patch when it merges. Their repository requires an issue and a
   maintainer's agreement first, which is why an agent did not open them.
6. **Schedule the merge agent**, after a second manual merge goes clean.
