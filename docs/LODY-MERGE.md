# Lody upstream merge runbook

Operational and evergreen. This is the procedure for pulling
[LodyAI/Lody](https://github.com/LodyAI/Lody) into `vendor/lody` and putting the
result back into a state where every gate passes. It is written so a scheduled
agent can execute it verbatim, on a fresh branch, without asking anything.

Design: `plans/LODY-SESSIONS.md` §5.3, §5.4. Conflict manual:
`vendor/lody/BLITZ-PATCHES.md`. Current pin: `vendor/lody/UPSTREAM.md`.

**Open a pull request. Never merge to `main` unattended.** The gates below say
whether the merge is mechanically sound. They cannot say whether an upstream
behaviour change is one this product wants, and nothing in this document is
allowed to decide that.

## 0. Before anything

```sh
git -C /path/to/BlitzOS worktree add -b lody-merge-$(date +%Y%m%d) /path/to/BlitzOS-lody-merge
cd /path/to/BlitzOS-lody-merge
npm ci
```

Record the starting point, because several steps below compare against it:

```sh
git rev-parse HEAD                                    # the branch point
grep 'Pinned commit' vendor/lody/UPSTREAM.md          # the current upstream sha
grep -n 'lody@' packages/box/Dockerfile               # the current npm pin
node scripts/lint-gate.mjs | tail -3                  # the baseline you must not raise
```

## 1. Is there anything to merge?

```sh
git fetch --no-tags https://github.com/LodyAI/Lody main
git log --oneline <pinned-sha>..FETCH_HEAD
git rev-list --count <pinned-sha>..FETCH_HEAD
```

No commits means stop and say so. Do not open an empty pull request.

Before pulling, find out whether upstream touched a file BlitzOS diverges in.
This is the single most useful thing to know first, because it is the difference
between a mechanical merge and one that needs judgement:

```sh
git diff --name-only <pinned-sha>..FETCH_HEAD -- \
  'vendor/lody/packages/components/src/providers/workspace-machine-rpc-facade.ts' \
  'vendor/lody/packages/components/src/providers/create-workspace-runtime.ts' \
  'vendor/lody/packages/components/src/window-globals.d.ts' \
  'vendor/lody/packages/components/src/components/loro-sidebar.tsx' \
  'vendor/lody/packages/components/src/lib/electron-session-file-sender.ts' \
  'vendor/lody/packages/components/src/components/sessions/session-chat-interface.tsx' \
  'vendor/lody/packages/components/src/components/sessions/session-detail.tsx' \
  'vendor/lody/packages/components/src/components/sessions/session-tab-bar.tsx'
```

(The paths inside the upstream tree have no `vendor/lody/` prefix; drop it when
comparing against `FETCH_HEAD` directly. The list is exactly the file list in
§4 below, and it is generated from `BLITZ-PATCHES.md`.)

## 2. The subtree pull, and the squash-commit caveat

```sh
git subtree pull --prefix vendor/lody https://github.com/LodyAI/Lody <ref> --squash
```

**The caveat, from phase 0, and it is the thing that goes wrong.** `--squash`
means `git subtree` reconstructs the upstream state from the SQUASH COMMIT
MESSAGE, not from a merge base it can see in the graph. It reads the line

```
git-subtree-split: <sha>
```

out of the last squash commit under this prefix. Consequences an agent must not
learn the hard way:

- **Never amend, reword, or rebase a subtree squash commit.** Rewriting that
  message loses the split sha, and the next pull re-imports the whole tree as
  new content — thousands of files, every seam patch conflicting at once.
- **Never squash the merge commit `git subtree pull` produces** when landing the
  pull request. Merge it, or the next pull sees no split sha.
- If the split sha is lost anyway, the recovery is `git subtree pull` with an
  explicit `--squash` against the OLD sha first to re-establish the marker; if
  that fails, re-add the subtree in a scratch worktree and diff.

Verify the marker survived before going further:

```sh
git log -1 --format=%B $(git rev-list -1 HEAD -- vendor/lody) | grep git-subtree-split
```

If the pull conflicts, resolve with `BLITZ-PATCHES.md` open. Every conflict
should be inside one of the eight files in §4; a conflict anywhere else means
somebody edited `vendor/lody` outside a declared seam, which is a finding to
report rather than to resolve quietly.

## 3. The npm `lody` pin, and the verified-pair rule

The renderer comes from this subtree and the daemon comes from npm, and **they
must move together.** The CRDT mirrors tolerate unknown fields, but nothing in
this port banks on skew: protocol v7 is a `z.literal`, and a renderer that
speaks v8 against a v7 daemon fails at the first frame.

The public tree lags the npm releases (it said `0.76.0` when npm was at
`0.88.1`), so "the version in `apps/cli/package.json`" is not the answer. Find
the npm release that corresponds to the subtree you just pulled:

```sh
npm view lody versions --json | tail -20
npm view lody@<candidate> dist.shasum
```

Then, in ONE change:

1. bump `lody@<version>` in `packages/box/Dockerfile`;
2. re-audit ALL FOUR patches in `packages/box/patches/` — see §5, none is
   optional and each is guarded twice;
3. record both numbers in `vendor/lody/UPSTREAM.md`.

If no npm release matches the subtree, **stay on the current npm pin and say so
in the pull request body.** A renderer merge with an unchanged daemon is a
supported state; a guessed daemon version is not.

## 4. Re-anchor the seam patches

`vendor/lody/BLITZ-PATCHES.md` is the conflict manual and lists every deliberate
divergence with its upstream anchor. After the pull, confirm the divergence is
still exactly what that file says:

```sh
git diff --stat <new-upstream-sha> $(git rev-parse HEAD:vendor/lody) -- . \
  ':!UPSTREAM.md' ':!BLITZ-PATCHES.md'
```

**Diff against the upstream COMMIT, never against the squash commit.** The
squash commit holds the upstream tree at its own root, with no `vendor/lody/`
prefix, so diffing a merged branch against it reports the whole vendored tree as
added — thousands of files, and no way to see the seven that matter. Comparing
the upstream commit to `HEAD:vendor/lody` (a tree, which `git diff` accepts) is
the comparison that answers the question.

**Expect exactly EIGHT files.** They are:

| # | File | Seam patch |
|---|---|---|
| 1 | `packages/components/src/providers/workspace-machine-rpc-facade.ts` | 1 (hunks 1–4) |
| 2 | `packages/components/src/providers/create-workspace-runtime.ts` | 1 (hunk 5) |
| 3 | `packages/components/src/window-globals.d.ts` | 1 (hunk 6) |
| 4 | `packages/components/src/components/loro-sidebar.tsx` | 2 |
| 5 | `packages/components/src/lib/electron-session-file-sender.ts` | 3 |
| 6 | `packages/components/src/components/sessions/session-chat-interface.tsx` | 4 |
| 7 | `packages/components/src/components/sessions/session-detail.tsx` | 4 and 5 |
| 8 | `packages/components/src/components/sessions/session-tab-bar.tsx` | 5 |

More than eight means a hunk landed somewhere undeclared. Fewer means a patch
was lost in the merge — which typecheck may not catch, because most of these
widen a predicate rather than change a type. Check each against its row in
`BLITZ-PATCHES.md`:

```sh
grep -rn '__LODY_LOCAL_BRIDGE__' vendor/lody/packages/components/src | wc -l   # expect 7
grep -n 'hideHeader\|hideFooter' vendor/lody/packages/components/src/components/loro-sidebar.tsx | head
grep -n 'readOnly' vendor/lody/packages/components/src/components/sessions/session-{detail,chat-interface}.tsx
grep -n 'surfaceTabs' vendor/lody/packages/components/src/components/sessions/session-{detail,tab-bar}.tsx
grep -n 'parentSession?' vendor/lody/packages/components/src/components/sessions/session-tab-bar.tsx
grep -n 'onSessionTabSelect\|onSessionMissing' vendor/lody/packages/components/src/components/sessions/session-detail.tsx
grep -n 'sideChatRequiresAssistantTurn\|activeTabAssistantTurnId' vendor/lody/packages/components/src/components/sessions/session-detail.tsx
```

The last three are seam patch 5, and they answer different questions.
`surfaceTabs` is the tab API and its content render; the two `onSession*`
callbacks are its outward edge — the page telling the host that its selection
is over (a conversation tab was chosen) or that its whole strip is gone (the
session does not exist), neither of which the host can observe; `parentSession?` is the one hunk
typecheck CANNOT catch in the other direction — losing it makes a REQUIRED prop
required again at a call site (`packages/webapp/src/lody/TerminalTabsStrip.tsx`)
that then stops compiling, so THAT loss is loud. What is quiet is upstream making
the strip read `parentSession` somewhere new, and
`packages/webapp/test/lody-surface-tabs.test.tsx` is what catches that.

The last one is seam patch 6, and it is the quietest of them all: the prop is
optional and the mirror it feeds is a `useState`, so losing any hunk compiles and
runs — the Side Chat launcher simply goes back to accepting a click it cannot
serve. `packages/webapp/test/lody-side-chat-guard.test.tsx` names each part for
that reason.

`BLITZ-PATCHES.md` carries a **merge conflict drill** for each patch, saying
what to do when the anchor is reworded and what to do when upstream replaces the
mechanism. Follow the drill; do not re-derive it.

**Then re-anchor its line numbers, in the same change.** Every number in that
file, and every line reference in §7's mirror table, is stated "at `<sha>`". A
merge moves most of them. A stale anchor is worse than no anchor: §7's whole
question is whether upstream fixed a defect, and an anchor pointing at the wrong
line reads as "yes".

**Re-take the seam baselines too.** `packages/webapp/test/upstream-baseline/`
holds pristine copies of the two files seam patch 5 patches, and
`packages/webapp/test/lody-surface-tabs.test.tsx` uses them to prove the
vendored tree lost no line `BLITZ-PATCHES.md` does not declare. They are
committed rather than read out of git on demand, because the upstream commit's
tree is only reachable from a full clone and CI does not have one. Refresh them
from a clone that DOES have the new commit, in the same change as the merge:

```sh
PIN=<the new upstream sha>
for f in session-tab-bar session-detail; do
  git show "$PIN:packages/components/src/components/sessions/$f.tsx" \
    > packages/webapp/test/upstream-baseline/"$f.tsx.txt"
done
```

Then move the sha in that directory's `README.md` and every anchor line number
in the test. The test fails when the README no longer names the pin
`UPSTREAM.md` states, so a forgotten refresh is loud rather than silent.

**Three of these patches DELETE when their upstream pull request lands.** Check
before re-applying — re-applying a patch upstream has already accepted is how a
fork starts:

| Seam patch | Upstream PR sketch | Delete when |
|---|---|---|
| 2 (`loro-sidebar.tsx`) | `plans/evidence/lody-sidebar-props-pr.md` | upstream has `hideHeader`/`hideFooter`, or any equivalent suppression |
| 3 (`electron-session-file-sender.ts`) | `plans/evidence/lody-attachment-seam-pr.md` | upstream's local-file-send predicate stops requiring Electron |
| 4 (`session-chat-interface.tsx`, `session-detail.tsx`) | `plans/evidence/lody-readonly-prop-pr.md` | upstream grows `readOnly` or its own viewer concept |
| 5 (`session-tab-bar.tsx`, `session-detail.tsx`) | `plans/evidence/lody-surface-tabs-pr.md` | upstream lets a host contribute tabs to the session tab strip, in any spelling |

**Three of them are still open and not yet submitted**: the read-only prop, the
attachment predicate and the surface-tabs props. None has been sent upstream, so
none can have merged; the sidebar props PR is drafted and in the same state. If a
scheduled agent finds one of these merged upstream, that is news — say so
prominently in the pull request body.

## 5. Re-audit the npm-artifact patches

Four scripts in `packages/box/patches/` are applied to the **published npm
artifact**, in the Dockerfile's order. The order is load-bearing:
`lody-local-platform.mjs` guards on a sha256 of the file AS PUBLISHED, so nothing
may rewrite it first. All four are idempotent — re-running any of them on an
already-patched bundle reports it and exits 0, which is what lets the daemon test
harness copy a real box's bundle and re-apply them to the copy.

### 5a. The platform patch

`packages/box/patches/lody-local-platform.mjs` is applied to the published npm
artifact, not to this tree. It restores the `LODY_PLATFORM` env read that
`lody`'s cloud build inlines away, and **without it a box cannot start the
daemon at all**. It is a standing obligation at every version bump.

It is guarded twice, so neglect fails the image build loudly:

- `EXPECTED_INPUT_SHA256` pins the sha256 of the published `dist/index.js`. Any
  new version fails here first.
- `EXPECTED_OCCURRENCES` pins the anchor count at **4**. A refactor that moves
  or splits the call sites fails here.

**All four sites, always.** One of them is the default argument of
`getInstallationProfile()`, which selects the whole installation profile.
Patching only the `getCliPlatformKind` site leaves the daemon running the local
composition under the CLOUD profile — socket basenames `lody-*`, host lease on
17788, data dir `~/.lody` — and the box depends on the LOCAL shape: `lody-oss-*`
basenames, port **17789**, `~/.lody-oss`. 17789 is pinned in
`RESERVED_PREVIEW_PORTS` and `lody-oss-` is the namespace
`/usr/local/libexec/blitz-lody-bridge` derives its socket paths from.

Re-auditing means, in order:

```sh
npm pack lody@<version> --pack-destination /tmp && tar -xzf /tmp/lody-<version>.tgz -C /tmp
sha256sum /tmp/package/dist/index.js
grep -c 'resolvePlatformKind("cloud")' /tmp/package/dist/index.js   # expect 4
node packages/box/patches/lody-local-platform.mjs /tmp/package/dist/index.js
LODY_PLATFORM=local node /tmp/package/dist/index.js start           # expect "Starting in local platform mode"
```

Then update `EXPECTED_INPUT_SHA256`, `EXPECTED_VERSION` and the Dockerfile pin
**together**, in the same commit.

### 5b. The ACP sign-in queue patch

`packages/box/patches/lody-acp-auth-queue.mjs` gives `machine/acp-authenticate`
its own chain in `MessageProcessor.extractQueueKey`. Without it every `machine/*`
message shares one serial chain, so the `submit-code` carrying a member's pasted
sign-in code queues behind the `claude auth login` that is blocking on stdin
waiting for it — and so does `cancel`. An interactive agent sign-in can then only
time out, after 285 s. See `plans/LODY-RUNTIME-DESIGN.md` §13.3.

Its guards are the installed package version and its own anchor at exactly one
occurrence, NOT a file sha256 — a file hash can only pin the first patch in a
chain. Re-auditing means:

```sh
grep -A 14 'extractQueueKey(message)' /tmp/package/dist/index.js
node packages/box/patches/lody-acp-auth-queue.mjs /tmp/package/dist/index.js
```

**If the new version already routes unnamed control messages off one shared
chain, DELETE this patch rather than updating it** — and say so prominently in
the pull request body, because it means the upstream defect is fixed.

### 5c. The Code Collab worktree-root patch

`packages/box/patches/lody-code-collab-worktree-root.mjs` makes
`resolveCodeCollabWorkspaceRoot` answer with a worktree session's WORKTREE. Its
local-project branch answers with the project's root path and reads neither
`project.useWorktree` nor `meta.isWorktree`, so as soon as no live `Session`
object is left, All Changes, the Files tab and every file chip of a BlitzOS
worktree session read the `/workspace/<repo>` clone. The clone is clean by
design, so the panel shows an empty SUCCESS — "No changes yet." — and never an
error. Reported from the first real worktree dogfood on canary.

Its guards are the installed package version and its own anchor at exactly one
occurrence. Re-auditing means:

```sh
grep -A 16 'if (project?.kind === "local") {' /tmp/package/dist/index.js  # the resolver's branch
node packages/box/patches/lody-code-collab-worktree-root.mjs /tmp/package/dist/index.js
npx vitest run test/lody-worktree-session.test.ts   # in packages/webapp, on a box with the bundle
```

**If the new version resolves a local-project worktree session to its worktree,
DELETE this patch rather than updating it.** Their own
`lib/terminal-workdir-resolver.ts:97` already does, so the two may converge.

### 5d. The assistant-message split patch

`packages/box/patches/lody-agent-message-split.mjs` groups streamed assistant
text by the `messageId` the ACP adapter already stamps on every chunk. Without
it, ONE Anthropic message is stored as two text blocks whenever anything — a
tool call, a subagent task — lands between two of its deltas, so the reader gets
a sentence cut in half around a tool card:

```
[21] text       "Three"
[22] tool_call  toolu_0166kpDv… (grep …)
[23] text       " characterization agents are running in parallel, plus …"
```

`claude-acp.js` computes the id (`messageIdForGrouping`, the API message `id`)
and `applyMessageId` puts it on the update; the schema keeps it
(`zContentChunk.messageId`); the history applier drops it and merges only into
`items[items.length - 1]`. The patch carries the id onto the stored item and
makes both `appendOrMergeAdjacentText` copies scan back past trailing non-text
items to the block with the same id. With no id it is byte-for-byte today's
behaviour, so every other adapter is untouched.

Six hunks, guarded by the installed package version plus each anchor at exactly
one occurrence. Re-auditing means:

```sh
grep -n 'appendOrMergeAdjacentText' /tmp/package/dist/index.js   # expect 6 lines, 2 definitions
grep -n 'messageId' /tmp/package/dist/index.js | head            # the applier must still ignore it
node packages/box/patches/lody-agent-message-split.mjs /tmp/package/dist/index.js
```

**If the new version merges by message id itself, DELETE this patch rather than
updating it.** The daemon already emits the id explicitly for grouping, so this
is the fix upstream is one step away from.

## 6. Dependencies and the patch-file audit

Upstream resolves renderer dependencies through pnpm's catalog; BlitzOS resolves
them through npm in `packages/webapp/package.json`.

```sh
git diff <pinned-sha>..FETCH_HEAD -- pnpm-workspace.yaml packages/components/package.json
```

For every catalog entry that moved and that `packages/webapp/package.json`
names, move ours to match. A dependency upstream ADDED that our build reaches
shows up as a resolve failure in step 7's build, not here.

Their `patchedDependencies` are applied by `scripts/apply-vendor-patches.mjs`
against `vendor/lody/patches/`. That script patches in place — there is no
second copy of a patch file to update — so the audit is:

```sh
git diff --stat <pinned-sha>..FETCH_HEAD -- patches/
grep -n 'patchedDependencies' -A 20 vendor/lody/pnpm-workspace.yaml
node scripts/apply-vendor-patches.mjs        # runs on postinstall too; must be silent
```

A patch whose target version moved fails here with the file and the hunk. A
patch upstream DELETED must be removed from the script in the same change.

## 7. The three workaround mirrors, and when they DELETE

`packages/webapp/src/lody/` holds three workarounds for upstream defects. Each
is a candidate for deletion at every merge, and each has an upstream fix
described in `vendor/lody/BLITZ-PATCHES.md` under "things upstream does not
support". **Check all three; delete the ones that have landed.**

| Mirror | What it repairs | Delete when upstream |
|---|---|---|
| `mirrorLocalProjectsToMachineMeta` (`local-projects.ts`) | archive resolves nothing for a local-project worktree, because the ARCHIVE caller does not pass `machineFlockRows` (`message-handler.ts:3971` vs `:4499`) | passes `machineFlockRows` on the archive path |
| `publishBoxReposAsWorkspaceRepos` (`local-projects.ts`) | a local project's repo name is dropped unless the cloud already knows the repo (`chat-landing.tsx:481`) | treats a local project's own remote as sufficient |
| `refreshLodyAcpCapabilities` (`agent-configs.ts`) | upstream's startup capabilities pass lists machines from the Convex-authorized set, which never contains a box (`create-workspace-runtime.ts:2415`) | lets the caller supply the machine list |

Each check is a `grep` in the pulled tree for the anchor named above. If the
anchor moved but the defect stands, update the line reference in
`BLITZ-PATCHES.md` — a stale anchor is how the next agent concludes it was
fixed.

## 8. Gates

```sh
npm run typecheck
npm run lint:gate
npm test
```

Then the two Go suites, which `npm test` does not run:

```sh
( cd packages/broker && go test ./... )
( cd packages/box/gateway && gofmt -l . && go test ./... )
```

`lint:gate` must PASS, not merely produce a number. **Never raise
`lint-baseline.json` to make a merge pass.** A merge that adds findings is
reporting an upstream change that our rules dislike; say so in the pull request
and leave the baseline alone.

The daemon-backed suites skip without a `lody` bundle installed at
`/opt/blitz/npm/lib/node_modules/lody`, which is the case on CI. On a machine
that has one they run, and a merge is much better validated with them:

```sh
ls /opt/blitz/npm/lib/node_modules/lody/dist/index.js && npm test
```

They serialize on a cross-file lock, so the run is slower rather than parallel;
that is expected. No live turn is ever spent: `BLITZ_LODY_LIVE_TURN` is unset.

## 9. Open the pull request

```sh
git push -u origin <branch>
gh pr create --title 'chore(vendor): merge Lody <short-sha>' --body-file <file>
```

The body says, at minimum:

- the upstream range merged, and the commit count;
- which of the seven divergent files upstream touched, and how each conflict was
  resolved;
- whether the npm `lody` pin moved, and if not, why;
- the gate output, verbatim;
- anything from step 7 that could be deleted, and whether it was;
- every friction point, appended to §11 of this document in the same PR.

**Never merge unattended.** A green PR is the runbook's output; the decision is
a person's.

## 10. If something breaks

| Symptom | Where to look |
|---|---|
| the pull re-imports the whole tree | §2 — the split sha is gone from the squash commit |
| typecheck fails inside `vendor/lody` | not ours to fix; the vendored tree is excluded from our tsconfig — check the alias list in `packages/webapp/vite.config.ts` and the stubs in `src/lody/stubs/` |
| a `@lody/*` import resolves to nothing | a package upstream moved or renamed; the aliases are in `packages/webapp/vite.config.ts` |
| the surface mounts and renders nothing | a provider upstream added. `SessionSurface`'s module comment lists what is deliberately not mounted, and `inert-auth-client.ts` throws a TypeError naming any new call site |
| a daemon-backed suite times out with an empty log | an orphaned daemon holds the local profile's host lease: `ss -lntp \| grep 17789` |
| the box cannot start its daemon | §5 — the platform patch |

## 11. Friction log

Appended by each merge, newest first. A runbook that does not record what went
wrong is a runbook that will go wrong the same way again.

### 2026-08-30 — `966623d0` → `f3474894`, 11 commits (the first merge)

The rehearsal that validated this document. Outcome: **the seam architecture
held.** One conflict, mechanical; the divergence came out at exactly seven files;
every gate green.

| # | Friction | Fixed by |
|---|---|---|
| 1 | §4's verification command diffed against the SQUASH commit and reported the entire vendored tree as added. A squash commit holds the upstream tree at its own root, with no prefix. | The command above, and the same correction in `vendor/lody/BLITZ-PATCHES.md`. |
| 2 | The one conflict was `window-globals.d.ts`: upstream widened `__LODY_PLATFORM__` with `preferredSystemLanguages` on the line above our `__LODY_LOCAL_BRIDGE__` declaration. Textually adjacent, semantically unrelated. | Keep both. This is what seam patch 1's drill describes, and it took one edit. |
| 3 | `session-chat-interface.tsx` — seam patch 4, added in the same phase — auto-merged with no conflict, upstream having touched it in the same file 4,000 lines away. | Nothing. Recorded because it is the good case and it is worth knowing the seams are not all equally fragile. |
| 4 | **Every line number in `BLITZ-PATCHES.md` had moved**, including the three workaround anchors in §7 whose whole purpose is to say whether upstream fixed the defect. A stale anchor reads as "fixed". | Re-anchored in the same commit. Make this step explicit at every merge: the anchors are load-bearing, not decoration. |
| 5 | `npm test` failed FIVE cases in `lody-sharing-relay.test.ts` — and it was not the merge. Phase 7 had taught the harness's shim to strip an inbound `X-Blitz-Lody-Share`, as the real gateway does, which closed a shortcut that test had been taking: it set the header itself on the un-prefixed path. | The test now dials `harness.sharedEndpoints(claim)`, which is how a grantee reaches a box in production. Better test, found by the gate. |
| 6 | `lody-worktree-session.test.ts` failed once inside a full `npm test` and passed alone, twice. The daemon-backed suites serialize on a cross-file lock and a full run spends ~11 minutes of test time. | Re-run before believing it. Not a merge signal. |

**What did NOT move:** the npm `lody` pin. npm's latest is still `0.88.1`, so
§3's rule applies — the daemon stays where it is, and the platform patch needed
no re-audit because the artifact it patches did not change.

**All three workaround mirrors are still needed.** Checked against the new tree:
the archive path still does not pass `machineFlockRows`
(`message-handler.ts:3989` vs `:4518`), `resolveLocalProjectGithubRepoFullName`
still gates on the cloud repo list (`chat-landing.tsx:481`), and the startup
capabilities pass still lists machines from the Convex-authorized set
(`create-workspace-runtime.ts:2416`).
