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
  'vendor/lody/packages/components/src/components/sessions/session-detail.tsx'
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
should be inside one of the seven files in §4; a conflict anywhere else means
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
2. re-audit `packages/box/patches/lody-local-platform.mjs` — see §5, this is not
   optional and it is guarded twice;
3. record both numbers in `vendor/lody/UPSTREAM.md`.

If no npm release matches the subtree, **stay on the current npm pin and say so
in the pull request body.** A renderer merge with an unchanged daemon is a
supported state; a guessed daemon version is not.

## 4. Re-anchor the seam patches

`vendor/lody/BLITZ-PATCHES.md` is the conflict manual and lists every deliberate
divergence with its upstream anchor. After the pull, confirm the divergence is
still exactly what that file says:

```sh
git diff --stat <subtree-import-commit> -- vendor/lody \
  ':!vendor/lody/UPSTREAM.md' ':!vendor/lody/BLITZ-PATCHES.md'
```

**Expect exactly SEVEN files.** They are:

| # | File | Seam patch |
|---|---|---|
| 1 | `packages/components/src/providers/workspace-machine-rpc-facade.ts` | 1 (hunks 1–4) |
| 2 | `packages/components/src/providers/create-workspace-runtime.ts` | 1 (hunk 5) |
| 3 | `packages/components/src/window-globals.d.ts` | 1 (hunk 6) |
| 4 | `packages/components/src/components/loro-sidebar.tsx` | 2 |
| 5 | `packages/components/src/lib/electron-session-file-sender.ts` | 3 |
| 6 | `packages/components/src/components/sessions/session-chat-interface.tsx` | 4 |
| 7 | `packages/components/src/components/sessions/session-detail.tsx` | 4 |

More than seven means a hunk landed somewhere undeclared. Fewer means a patch
was lost in the merge — which typecheck may not catch, because most of these
widen a predicate rather than change a type. Check each against its row in
`BLITZ-PATCHES.md`:

```sh
grep -rn '__LODY_LOCAL_BRIDGE__' vendor/lody/packages/components/src | wc -l   # expect 7
grep -n 'hideHeader\|hideFooter' vendor/lody/packages/components/src/components/loro-sidebar.tsx | head
grep -n 'readOnly' vendor/lody/packages/components/src/components/sessions/session-{detail,chat-interface}.tsx
```

`BLITZ-PATCHES.md` carries a **merge conflict drill** for each patch, saying
what to do when the anchor is reworded and what to do when upstream replaces the
mechanism. Follow the drill; do not re-derive it.

**Three of these patches DELETE when their upstream pull request lands.** Check
before re-applying — re-applying a patch upstream has already accepted is how a
fork starts:

| Seam patch | Upstream PR sketch | Delete when |
|---|---|---|
| 2 (`loro-sidebar.tsx`) | `plans/evidence/lody-sidebar-props-pr.md` | upstream has `hideHeader`/`hideFooter`, or any equivalent suppression |
| 3 (`electron-session-file-sender.ts`) | `plans/evidence/lody-attachment-seam-pr.md` | upstream's local-file-send predicate stops requiring Electron |
| 4 (`session-chat-interface.tsx`, `session-detail.tsx`) | `plans/evidence/lody-readonly-prop-pr.md` | upstream grows `readOnly` or its own viewer concept |

**Two of them are still open and not yet submitted** (phase 7): the read-only
prop and the attachment predicate. Neither has been sent upstream, so neither
can have merged; the sidebar props PR is drafted and in the same state. If a
scheduled agent finds one of these merged upstream, that is news — say so
prominently in the pull request body.

## 5. Re-audit the platform patch

`packages/box/patches/lody-local-platform.mjs` is applied to the **published npm
artifact**, not to this tree. It restores the `LODY_PLATFORM` env read that
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

*(No entries yet beyond the rehearsal below.)*
