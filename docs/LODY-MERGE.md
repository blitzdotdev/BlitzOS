# Lody upstream merge runbook

This is the single procedure for importing
[LodyAI/Lody](https://github.com/LodyAI/Lody) into `vendor/lody`, proving the
renderer and daemon from the same tree, and opening the result for review.
`vendor/lody/BLITZ-PATCHES.md` is the seam and conflict manual;
`vendor/lody/UPSTREAM.md` records pins.

**Open a pull request. Never merge to `main` unattended.** Automation may
prepare and push the branch, but it must never enable auto-merge or call
`gh pr merge`. A green gate proves mechanics, not that BlitzOS wants every new
upstream behavior.

## Status

The target command is:

```sh
npm run lody:merge -- --ref <release-tag-or-main>
```

It is not present in the root `package.json` yet. Use the manual equivalent in
this runbook for every row marked manual.

| Step | Status at HEAD | Target owner |
|---|---|---|
| Resolve the ref, pull the subtree, update pins and baselines, run gates, push, and open the PR | **Manual until plan PR E** | `scripts/lody-merge.mjs` through `npm run lody:merge` |
| Materialize the five CLI adapters at their gitlink SHAs | **Automated by `npm run lody:adapters:sync`** | `scripts/lody-sync-adapters.mjs` and reviewed `vendor/lody-adapters/` trees |
| Build, check, pack, and stamp the daemon from the merged tree | **Automated by `npm run lody:build` and the image's `lody-build` stage** | shared `scripts/lody-build-package.mjs` |
| Run the real-daemon pair matrix against the PR artifact | **Required in the `lody-daemon` CI job** | `LODY_BUNDLE` and `LODY_CLAUDE_BINARY` select the job's installed artifact |
| Serve and compare daemon provenance | **Inspect `BUILD.json` locally until plan PR D** | `/lody/build` plus browser comparison; legacy boxes have no route |
| Publish and deploy a canary box image after merge | **Automated now by `.github/workflows/canary.yml`** | The release key covers every repository path copied by the Dockerfile, including all Lody build inputs |

The shipping image builds and installs the daemon package from this same
vendored tree. There is no npm daemon release to select or bump during an
upstream merge. The renderer/daemon identity is the upstream commit and build
stamp, never the stale `apps/cli/package.json` version.

## Prepare a branch

Start from current `main` in a clean worktree. Record the branch point and old
pin before changing anything.

```sh
git status --porcelain
npm ci
BRANCH_POINT=$(git rev-parse HEAD)
OLD_SHA=$(sed -n 's/| Pinned commit | `\([0-9a-f]\{40\}\)` |/\1/p' vendor/lody/UPSTREAM.md)
test -n "$OLD_SHA"
printf 'branch=%s\nold Lody=%s\n' "$BRANCH_POINT" "$OLD_SHA"
```

Prefer a public release tag. `main` is allowed when the needed change has no
release, but label the PR `UNRELEASED UPSTREAM` and run the entire pair matrix.

```sh
LODY_REF=<release-tag-or-main>
LODY_URL=https://github.com/LodyAI/Lody
git fetch --no-tags "$LODY_URL" "$LODY_REF"
NEW_SHA=$(git rev-parse FETCH_HEAD^{commit})
git log --oneline "$OLD_SHA..$NEW_SHA"
git rev-list --count "$OLD_SHA..$NEW_SHA"
```

Stop without opening a PR when the count is zero.

## Inventory the seams before pulling

Derive the declared seam-file inventory from `BLITZ-PATCHES.md`, then prove it
covers every current upstream divergence. This avoids another hard-coded file
list drifting as seams are added or retired.

```sh
DECLARED_SEAM_FILES=$(mktemp)
ACTUAL_SEAM_FILES=$(mktemp)
UNDECLARED_SEAM_FILES=$(mktemp)
grep -oE '`(apps|packages)/[^`]+\.(ts|tsx|js|mjs)`' \
  vendor/lody/BLITZ-PATCHES.md | tr -d '`' | sort -u | \
  while IFS= read -r file; do
    git cat-file -e "HEAD:vendor/lody/$file" 2>/dev/null && printf '%s\n' "$file"
  done > "$DECLARED_SEAM_FILES"
git diff --name-only "$OLD_SHA" "$(git rev-parse HEAD:vendor/lody)" -- . \
  ':!UPSTREAM.md' ':!BLITZ-PATCHES.md' | sort -u > "$ACTUAL_SEAM_FILES"
comm -23 "$ACTUAL_SEAM_FILES" "$DECLARED_SEAM_FILES" \
  > "$UNDECLARED_SEAM_FILES"
if [ -s "$UNDECLARED_SEAM_FILES" ]; then
  sed 's/^/undeclared vendor divergence: /' "$UNDECLARED_SEAM_FILES" >&2
  exit 1
fi
git diff --name-only "$OLD_SHA" "$NEW_SHA" -- $(cat "$DECLARED_SEAM_FILES")
```

The last command is the review forecast: it reports declared seam files that
upstream touched. Numbers from earlier merges are examples, not contracts. One
large merge covered 152 upstream commits and required review of six seam files
and 16 local hunks; a later merge may have none or many more.

Also inspect upstream changes around ambient IPC. The source audit in the gates
is authoritative; this early search identifies likely human-review sites.

```sh
git diff "$OLD_SHA" "$NEW_SHA" -- packages/components/src | \
  grep -E 'getIpcServices|onIpcEvent|sendIpc|sendLocalSessionControl|getPublicBrowserBridge|window\.ipc' || true
```

## Pull the subtree without losing its marker

`--squash` reconstructs history from the squash commit message's
`git-subtree-split: <sha>` trailer. Confirm the old marker is reachable before
asking Git to pull new content:

```sh
OLD_SUBTREE_COMMIT=$(git log HEAD --fixed-strings \
  --grep="git-subtree-split: $OLD_SHA" --format='%H' -1)
if [ -z "$OLD_SUBTREE_COMMIT" ]; then
  git subtree pull --prefix vendor/lody "$LODY_URL" "$OLD_SHA" --squash
  OLD_SUBTREE_COMMIT=$(git log HEAD --fixed-strings \
    --grep="git-subtree-split: $OLD_SHA" --format='%H' -1)
fi
test -n "$OLD_SUBTREE_COMMIT"
```

That old-pin pull is the recovery when an earlier rewrite lost the split
trailer. If it cannot establish the marker, re-add the old subtree in a scratch
worktree and compare it before proceeding. Never accept a pull that appears to
re-import the whole tree.

Now pull the resolved new commit:

```sh
git subtree pull --prefix vendor/lody "$LODY_URL" "$NEW_SHA" --squash
```

If the new pull reports conflicts, skip the new marker check for the moment,
resolve every conflict by the next section, then finish the prepared subtree
commit without rewriting its message:

```sh
git add vendor/lody
git commit --no-edit
```

Return here and verify the marker before doing any other merge work.

Preserve the new marker:

- Never amend, reword, rebase, or squash the subtree squash commit.
- Land the PR with a merge commit. Do not use GitHub's squash or rebase merge.
- Verify the marker before continuing.

```sh
SUBTREE_COMMIT=$(git log HEAD --fixed-strings \
  --grep="git-subtree-split: $NEW_SHA" --format='%H' -1)
test -n "$SUBTREE_COMMIT"
git show -s --format='%B' "$SUBTREE_COMMIT" | \
  grep -F "git-subtree-dir: vendor/lody"
git show -s --format='%B' "$SUBTREE_COMMIT" | \
  grep -F "git-subtree-split: $NEW_SHA"
```

## Resolve conflicts by class

Open `vendor/lody/BLITZ-PATCHES.md` for every conflict. Conflicts outside a
declared seam are evidence of an undeclared vendor edit; stop and report them.

| Class | Meaning | Resolution |
|---|---|---|
| A | Upstream now supplies the behavior | Delete the Blitz seam and its declaration; use upstream's API |
| B | The behavior is still needed and only its source anchor moved | Reapply the same narrow behavior using that seam's conflict drill; update anchors and tests |
| C | Upstream changed the mechanism or product meaning | Stop for a human decision; do not invent a reconciliation |

After the tree is resolved, update `vendor/lody/UPSTREAM.md` with `NEW_SHA`,
the upstream commit date/title, the current date, and `SUBTREE_COMMIT`. Do not
add an npm row.

## Reconcile the source seams

Diff the upstream commit against the vendored tree, not against the Blitz
squash commit. The upstream commit and `HEAD:vendor/lody` both expose Lody paths
at the tree root; the squash commit does not.

```sh
git diff --stat "$NEW_SHA" "$(git rev-parse HEAD:vendor/lody)" -- . \
  ':!UPSTREAM.md' ':!BLITZ-PATCHES.md'
git diff --name-only "$NEW_SHA" "$(git rev-parse HEAD:vendor/lody)" -- . \
  ':!UPSTREAM.md' ':!BLITZ-PATCHES.md' | sort -u > "$ACTUAL_SEAM_FILES"
comm -23 "$ACTUAL_SEAM_FILES" "$DECLARED_SEAM_FILES" \
  > "$UNDECLARED_SEAM_FILES"
if [ -s "$UNDECLARED_SEAM_FILES" ]; then
  sed 's/^/undeclared vendor divergence: /' "$UNDECLARED_SEAM_FILES" >&2
  exit 1
fi
```

For every retained seam, refresh the upstream anchor and line number in
`BLITZ-PATCHES.md`. Run its conflict drill and delete any seam whose upstream
replacement has landed. Daemon seams 19-21 cover the ACP-authentication queue,
the optional built-in MCP server, and host-selected cgroup parent/capacity
policy. Their environment options retain upstream defaults when absent; the box
service selects the host behavior. The ACP rule moves only an authentication
`start` to `acp-auth:<configId>`; submit and cancel remain on the default chain.
Renderer seams 22 and 23 add the sidebar footer slot and host side-panel tabs.
The browser-panel seam numbered 20 on main was withdrawn before the merge.

The ambient-IPC audit is not a formatting gate. Any newly reachable unbound IPC
site reported by `lody-ipc-client-isolation.test.ts` is a class-C decision.

## Refresh pristine baselines

The seam tests read checked-in pristine upstream sources because shallow CI
clones may not contain the upstream commit object. Refresh all eight from a
clone that contains `NEW_SHA`:

```sh
for file in sessions/session-tab-bar sessions/session-detail \
            sessions/session-side-panel-tab-bar \
            mobile/mobile-session-tab-sheet mobile/mobile-home-screen; do
  git show "$NEW_SHA:packages/components/src/components/$file.tsx" \
    > "packages/webapp/test/upstream-baseline/$(basename "$file").tsx.txt"
done
git show "$NEW_SHA:apps/cli/src/lib/message-processor.ts" \
  > packages/webapp/test/upstream-baseline/message-processor.ts.txt
git show "$NEW_SHA:apps/cli/src/agent/agent-client.ts" \
  > packages/webapp/test/upstream-baseline/agent-client.ts.txt
git show "$NEW_SHA:apps/cli/src/mcp/lody-mcp-http-server.ts" \
  > packages/webapp/test/upstream-baseline/lody-mcp-http-server.ts.txt
```

Update the provenance SHA in
`packages/webapp/test/upstream-baseline/README.md`, then move each line-number
anchor in `packages/webapp/test/lody-seam-pin.test.ts` and
`vendor/lody/BLITZ-PATCHES.md` to the corresponding line in the new pristine
source. Never weaken a test merely because an anchor moved.

## Reconcile dependencies and workarounds

Upstream resolves through its pnpm catalog; the Blitz webapp resolves the
renderer dependencies through `packages/webapp/package.json`. Review both the
catalog and upstream patch set.

```sh
git diff "$OLD_SHA" "$NEW_SHA" -- \
  pnpm-workspace.yaml packages/components/package.json patches/
grep -n 'patchedDependencies' -A 30 vendor/lody/pnpm-workspace.yaml
node scripts/apply-vendor-patches.mjs
```

Move every renderer dependency that Blitz names to the upstream catalog value.
Remove a deleted upstream patch from `scripts/apply-vendor-patches.mjs`; there
is no second patch copy. Recheck the guarded `@pierre/diffs` side-effects fix
there and delete it if upstream's published package now names the shipped
`dist/components/web-components.js` or drops `sideEffects`.

Review the workaround inventory under “Things upstream does not support” in
`BLITZ-PATCHES.md`. In particular, delete a mirror when upstream:

- passes `machineFlockRows` on the archive worktree-cleanup path;
- accepts a local project's own remote without a cloud repository row; or
- lets the local runtime supply the machine list for ACP capability refresh.

Update every moved anchor even when the workaround remains.

## Sync adapters at the gitlink SHAs

The CLI workspace uses five adapter gitlinks: core, Claude, Codex, DSH, and
Grok. Kimi remains a gitlink but is excluded by
`vendor/lody/pnpm-workspace.yaml`; do not materialize it for this build.

Sync, review, stage, and check the reviewed trees:

```sh
npm run lody:adapters:sync
git diff -- vendor/lody-adapters
git add vendor/lody-adapters
npm run lody:adapters:check
npm run lody:adapters:check -- --fetch
```

The sync fetches each exact public gitlink commit, archives only its tracked
tree, and removes `dist/` and `node_modules/`. It then replaces the matching
`vendor/lody-adapters/<name>/` snapshot. Tests, docs, and lockfiles remain.
Sync reports the old and new SHAs plus file write and removal counts. It exits
without comparing its output to the old index.

The first check uses no network. It proves all five stamps match their gitlinks
and `.gitmodules`. It also checks package presence and rejects unstaged snapshot
changes. The fetch check exports every exact upstream commit and compares its
bytes and modes with the staged snapshot. Record all six gitlink SHAs and any
adapter-tree changes in the PR body.

## Build and stamp the daemon

Build the same package the image installs. Every retained daemon seam already
lives in the subtree; the builder never rewrites the compiled output.

```sh
LODY_OUT=$(mktemp -d)
npm run lody:build -- --out "$LODY_OUT"
mapfile -t TARBALLS < <(find "$LODY_OUT" -maxdepth 1 -type f -name 'lody-*.tgz' -print)
test "${#TARBALLS[@]}" -eq 1
TARBALL=${TARBALLS[0]}
jq . "$LODY_OUT/BUILD.json"
```

The script exports `HEAD:vendor/lody`, overlays the five reviewed adapters,
creates a Corepack shim for upstream's bare `pnpm` calls, performs the frozen
install and build, and copies the notice. It derives an npm lockfile v3
shrinkwrap from `apps/cli` production dependencies in `pnpm-lock.yaml`.
Every runtime package has the reviewed version, tarball URL, and integrity.
The script also checks the short required-asset manifest. Missing workers,
presets, WASM, the notice, the shrinkwrap, or the stamp fail the build.
Unrelated chunks are allowed. The identical stamp sits beside the tarball and
inside `dist/BUILD.json`. `distSha256` covers sorted path and content-digest
records for `dist`, except the self-referential stamp. A measured warm build
took about 91 seconds. That is evidence, not a timeout.

For a Docker builder without Git, pass `--source /path/to/lody`. The script
reads source identity from that tree's `UPSTREAM.md` and adapter identity from
the reviewed `vendor/lody-adapters` stamps beside the script's repository root.

## Run the pair gate

Extract the tarball into a temporary prefix. Run npm at the package root so it
enforces the included shrinkwrap. Then point the harness at that directory:

```sh
mkdir -p "$LODY_OUT/install/lib/node_modules" "$LODY_OUT/unpack"
tar -xzf "$TARBALL" -C "$LODY_OUT/unpack"
mv "$LODY_OUT/unpack/package" "$LODY_OUT/install/lib/node_modules/lody"
npm ci --prefix "$LODY_OUT/install/lib/node_modules/lody" --omit=dev
export LODY_BUNDLE="$LODY_OUT/install/lib/node_modules/lody"
test -f "$LODY_BUNDLE/dist/index.js"
```

Set `LODY_CLAUDE_BINARY` to the same Claude CLI used by the image when the
default `/opt/blitz/npm/bin/claude` does not exist. The post-sign-in suite names
that missing prerequisite when it skips. Run every non-probe harness consumer
serially:

```sh
cd packages/webapp
PAIR_TESTS=$(grep -rl --include='*.test.ts' --include='*.test.tsx' \
  'lody-daemon-harness' test | grep -v '\.probe\.' | sort)
npx vitest run --maxWorkers=1 $PAIR_TESTS
cd ../..
```

At HEAD that discovery selects these 15 suites:

```text
lody-acp-authentication        lody-archive-lifecycle
lody-attachments               lody-post-signin-turn
lody-project-control-frames    lody-rail-groups
lody-session-rail              lody-session-roundtrip
lody-session-surface           lody-session-workdir
lody-shared-endpoints          lody-shared-surface
lody-sharing-relay             lody-worktree-composer
lody-worktree-session
```

The discovery command, rather than this snapshot, is authoritative when a new
harness consumer lands. `lody-session-surface`, `lody-session-rail`, and
`lody-post-signin-turn` are the minimum smoke subset, not the whole gate.

Leave `BLITZ_LODY_LIVE_TURN` unset. Tests that dispatch a paid model turn skip
by design in `lody-post-signin-turn`, `lody-session-rail`,
`lody-session-roundtrip`, `lody-session-surface`, `lody-shared-surface`, and
`lody-worktree-composer`; their remaining cases must run. The
`lody-keepalive-activation` and `lody-switch-cost` probe suites in that directory
also stay out of PR CI; they require `BLITZ_LODY_SWITCH_PROBE=1` and belong in a
scheduled/manual performance run.

Run the daemon-free bridge boundary gates too. They use stand-ins and are not
evidence that the built daemon starts, but they protect the box boundary:

```sh
cd packages/box/guest-tests
npx vitest run --maxWorkers=1 \
  test/lody-bridge-frames.test.ts \
  test/lody-bridge-control-stream.test.ts \
  test/lody-bridge-share.test.ts \
  test/lody-projects-registration.test.ts
cd ../../..
```

The required `lody-daemon` job runs this discovery against the artifact it just
built and fails explicitly if a non-paid suite reports a bundle-absence skip.
Before installing that artifact, it also runs the focused authentication-queue,
built-in-MCP request/reminder, and session-sandbox tests in the preserved
scratch tree that produced it.

The install fetches only the shrinkwrap's exact registry tarball URLs. npm
checks every integrity before extraction. Lifecycle scripts remain enabled for
native dependencies in the target runtime. The reviewed Lody workspace marks
`better-sqlite3` 13 as build-ignored because its package already carries
platform prebuilds. The pair gate proves those locked dependencies install and
the resulting daemon starts.

## Recapture fixture corpora only for semantic changes

Validate these daemon-authored corpora against the just-built daemon:

- `packages/schema/fixtures/lody-data-plane/server/`, except its two documented
  synthesized cases, retaining the derived chunked frame;
- `packages/schema/fixtures/lody-project-registration/request/` and
  `response/`;
- the non-synthesized stream and envelope cases in
  `packages/schema/fixtures/lody-session-control-stream/`; and
- `packages/schema/fixtures/lody-share-claim/catalog-full.json`, regenerating
  `catalog-shared.json` through the real bridge projection.

Do not churn real IDs on every merge. Re-capture only when reviewed protocol
behavior changes, and normalize only the nondeterministic IDs and timestamps
each README already documents. Until `scripts/lody-validate-fixtures.mjs`
lands, drive the capture scenarios with the pair harness and run every listed
conformance test. After it lands, validation uses the PR-built artifact and is
mandatory.

Every recaptured corpus README must contain this exact provenance form with
real values:

```text
Captured from the daemon built from `vendor/lody` at `<upstreamSha>` (`distSha256` `<sha>`).
```

The qualified README paragraphs naming the old npm daemon in the captured
corpora are historical capture facts, not a daemon-selection rule.

## Run all gates

Run the focused seam pins first, then the repository and Go gates:

```sh
cd packages/webapp
npx vitest run --maxWorkers=1 \
  test/lody-seam-pin.test.ts \
  test/lody-v1-scope-sources.test.ts \
  test/lody-ipc-client-isolation.test.ts
cd ../..

npm run typecheck
npm run lint:gate
npm test
( cd packages/broker && go test ./... )
( cd packages/box/gateway && test -z "$(gofmt -l .)" && go test ./... )
git diff --check
```

`lint:gate` must pass; never raise `lint-baseline.json` to absorb upstream
findings. Once present, also require the adapter-drift, pin-provenance,
dist-manifest, notices, source-seam behavior, fixture-validation, built-image
smoke, `/lody/build` contract, pair-matrix, and canary-image-input gates named
in `plans/LODY-DAEMON-FROM-TREE.md`.

## What needs a human

Automation must stop for:

- a class-C seam conflict;
- upstream behavior that is mechanically valid but unwanted in BlitzOS;
- a red or unexpectedly skipped non-paid pair gate;
- a new ambient IPC site reported by the source audit;
- a fixture semantic change that requires a reviewed recapture;
- the final PR review and merge click.

Everything else is routine evidence gathering and may be automated.

## Open the pull request and stop

Until plan PR E opens the PR itself:

```sh
git push -u origin "$(git branch --show-current)"
gh pr create --title "chore(vendor): merge Lody ${NEW_SHA:0:12}" --body-file <file>
```

The PR body must include:

- old and new upstream SHAs, ref, commit list/count, and whether it is a release;
- all six adapter gitlink SHAs and adapter-tree changes;
- every seam file upstream touched and its A/B/C resolution;
- deleted seams, retained workarounds, and new ambient IPC findings;
- tarball and `BUILD.json` identity plus package-output review;
- fixture validation or reviewed recapture details;
- exact gate results, including paid/probe skips; and
- canary transition impact.

Do not merge it. A person reviews the upstream behavior and clicks merge.

## What happens after the human merge

Every push to `main` runs the `image` job in
`.github/workflows/canary.yml`. It derives a SHA-256 release ID from the Git
object IDs for every repository path copied by the Dockerfile. These inputs
include `packages/box`, `packages/broker`, `packages/schema/fixtures`,
`env.defaults`, `vendor/lody`, `vendor/lody-adapters`, and all Lody build scripts.
The canonical list lives in
`packages/control-plane/scripts/lib/box-image-inputs.mjs` and
`packages/control-plane/scripts/box-image-key.mjs`. It validates and reuses an
existing matching manifest or builds an amd64 image with Lody sessions enabled,
boot-smokes that enabled image, publishes parts before the manifest under
immutable `box-image/<releaseId>/` keys through
`packages/control-plane/scripts/publish-box-image.mjs`, passes the exact
ref/tag/archive digest to `deploy`, and verifies both commit and image tag through
`/version`.

`box-image-key.test.mjs` parses build-context `COPY` instructions and rejects
an uncovered source. It also proves each Lody input changes the release ID.
The key reads Git tree and blob IDs, so large adapter trees remain fast.
Gitlinks inside `vendor/lody` contribute to its tree ID without a file walk.

A vendor-only merge therefore selects a matching immutable image. The image is
reused or baked, published, pinned, and deployed without a follow-up source
commit. Plan PR D adds `/lody/build` so the browser can compare the package's
own stamp with its renderer commit.

New boxes use the newly deployed pin. Existing cloud boxes replace their
container only after `updateRequested` is set through
`packages/control-plane/core/box-config.ts`; microVMs have no in-place update
path. An upstream merge never silently kills every running field box.

## Where things are documented

| Document | Scope |
|---|---|
| `docs/LODY-MERGE.md` | The one current upstream-merge procedure |
| `vendor/lody/BLITZ-PATCHES.md` | Declared seams, upstream anchors, conflict drills, and workaround inventory |
| `vendor/lody/UPSTREAM.md` | The upstream revision, subtree squash commit, and adapter gitlink pins |
| `plans/LODY-DAEMON-FROM-TREE.md` | Approved source-built-daemon design, gates, and migration PRs |
| `plans/LODY-SESSIONS.md` | Historical design rationale; its old merge and npm-pin rules are superseded |
