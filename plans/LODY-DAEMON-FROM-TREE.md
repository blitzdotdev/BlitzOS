# Build the Lody daemon from the vendored tree

Status: approved direction; implementation is split into five shippable pull
requests below. The target is one upstream Lody revision for both renderer and
daemon, with no independently selected npm daemon release.

## Decision and evidence

The box currently installs `lody@0.88.1` globally, copies that npm tree into the
runtime image, and rewrites its compiled `dist/index.js` with three scripts
(`packages/box/Dockerfile:38-59`, `packages/box/Dockerfile:131-138`). The renderer
comes from the squashed public subtree, and the current policy calls the npm
version plus subtree revision one verified pair (`CLAUDE.md:115-131`,
`vendor/lody/UPSTREAM.md:27-31`). That policy has failed at the current pin: the
new renderer sends a capabilities-refresh shape that the old daemon rejects
(`vendor/lody/UPSTREAM.md:17-25`).

Build the daemon from `vendor/lody/apps/cli` at the same upstream revision as
the renderer. The completed spike is sufficient evidence for the decision:

- after materializing five adapter gitlinks, the frozen install and build
  completed in 130.67 seconds, of which the build was 91.13 seconds
  (`/var/lib/blitz/home/codex/daemonbuild-result.md:35-57`);
- the output was a 5.7 MB tarball with a 59.9 MB development `dist`, and
  `check:published-bundle-imports` passed
  (`/var/lib/blitz/home/codex/daemonbuild-result.md:68-76`);
- `lody-session-surface`, `lody-session-rail`, and `lody-post-signin-turn`
  passed against that self-built daemon, including the capabilities-refresh
  regression (`/var/lib/blitz/home/codex/daemonbuild-result.md:80-94`);
- the public source already builds local mode and already contains the Code
  Collab worktree fix, while the ACP authentication queue fix is still needed
  (`/var/lib/blitz/home/codex/daemonbuild-result.md:96-110`); and
- the package version remains the stale `0.76.0`, so commit provenance—not
  `lody --version`—has to identify the artifact
  (`/var/lib/blitz/home/codex/daemonbuild-result.md:13-31`).

## Invariants

1. One upstream SHA selects both renderer and daemon. There is no npm daemon
   version selection and no compatibility matrix.
2. Every byte needed to resolve the five CLI adapter workspaces is reviewed in
   this repository before an image bake. A bake never fetches an adapter Git
   repository.
3. The daemon is installed at
   `/opt/blitz/npm/lib/node_modules/lody` and its bin remains
   `/opt/blitz/npm/bin/lody`. Source provenance changes; runtime paths do not.
4. The packed artifact is installed, not a loose `dist/index.js`. All chunks,
   workers, presets, WASM, notices, and external runtime dependencies move as
   one unit.
5. A source-built daemon cannot enter an image unless the pin, adapter, frozen
   lockfile, published-bundle, output-set, notice, source-seam, and smoke gates
   all pass.
6. A browser may connect across an old-box transition. It reports a pair skew
   and gives a non-blocking update hint; it does not refuse the session surface.
7. Every Blitz-authored build-provenance payload has one fixture corpus and
   conformance on every producing, forwarding, and consuming runtime, as
   required by `CLAUDE.md:59-63`.
8. A successful upstream-merge PR changes the canary image input identity. A
   merge to `main` builds, publishes, pins, and deploys that image without a
   second source commit.
9. No automation merges an upstream PR. The runbook already makes explicit
   approval mandatory (`docs/LODY-MERGE.md:11-14`,
   `docs/LODY-MERGE.md:439-457`).

## Corrections to the proposed shape

The direction holds, with these code-grounded corrections.

1. **One core revision, not literally one supply-chain pin.** The Lody revision
   is singular, but five adapter commit IDs and `pnpm-lock.yaml` remain required
   inputs. `UPSTREAM.md` is the human-readable pin; the reachable squash
   commit's `git-subtree-split` trailer is its integrity mirror. They must agree,
   not act as two independently editable pins. The current file still carries
   the independent npm row and skew policy (`vendor/lody/UPSTREAM.md:8-31`).
2. **There are six gitlinks, but only five CLI build inputs.** The checked tree
   has core, Claude, Codex, DSH, Grok, and Kimi gitlinks. The CLI declares and
   builds only the first five (`vendor/lody/apps/cli/package.json:13-20`,
   `vendor/lody/apps/cli/package.json:69-73`), while the workspace explicitly
   excludes Kimi (`vendor/lody/pnpm-workspace.yaml:1-5`). Preserve and validate
   the Kimi gitlink, but do not materialize it for the CLI build.
3. **Do not replace gitlinks inside the subtree.** Replacing
   `vendor/lody/packages/acp-extension-*` with ordinary directories makes the
   next subtree pull reconcile a directory/gitlink type change in every adapter,
   contrary to the declared-seam-only rule (`vendor/lody/UPSTREAM.md:3-6`). Put
   the five reviewed trees under `vendor/lody-adapters/<name>/`; overlay them
   onto a build copy at the paths the CLI expects. This keeps the imported
   subtree structurally faithful and keeps the next pull mechanical.
4. **`check:published-bundle-imports` is already in `build`.** The upstream build
   runs it after bundling and presets and before the WASM copy
   (`vendor/lody/apps/cli/package.json:13-20`). Keep that command in the build
   chain and assert that it stays there; do not run an identical scan twice.
5. **The notice is not currently packable at package root.** `files` includes
   `dist`, `README.md`, and `LICENSE`, but not `THIRD_PARTY_NOTICES.md`
   (`vendor/lody/apps/cli/package.json:114-119`). Copy the root notice to
   `apps/cli/dist/THIRD_PARTY_NOTICES.md` after `build` and before `pnpm pack`,
   then require that exact tar entry. This avoids another persistent edit to an
   upstream package manifest.
6. **Use `/lody/build`, not a field on `/lody/platform`.** The owner platform
   response is deliberately byte-for-byte daemon catalog data
   (`packages/box/rootfs/usr/local/libexec/blitz-lody-bridge:20-44`,
   `packages/box/guest-tests/test/lody-bridge-frames.test.ts:245-249`), and shared
   requests already have a separately fixture-pinned projection
   (`packages/box/guest-tests/test/lody-bridge-share.test.ts:370-383`). A build
   field would silently turn the owner response into a Blitz-authored envelope.
7. **The control-plane version report cannot identify a running box.** It has
   `commit`, `boxImageRef`, and `migration`, not `boxImageTag`, and the image ref
   comes from deployment configuration (`packages/control-plane/core/version.ts:17-45`).
   It says what a new box would boot, not what answered this browser request.
8. **A SHA mismatch does not prove which side is older.** Commit IDs have no
   ordering in the browser. The hint must say “This box and the app run
   different Lody builds; update the box to match,” not assert that the box is
   older. “Restart to update” is also inaccurate: cloud-VM replacement happens
   only after `updateRequested` is set (`packages/control-plane/core/box-config.ts:21-29`,
   `packages/control-plane/core/box-config.ts:142-180`).
9. **Canary has no image job or release hash today.** It has one `deploy` job,
   an advisory that images are built by hand, and three hard-coded R2 values
   (`.github/workflows/canary.yml:22-31`, `.github/workflows/canary.yml:81-98`,
   `.github/workflows/canary.yml:134-155`). Add an image job; there is no
   existing one to extend.
10. **The current image-change detector would miss every Lody subtree merge.**
    It watches only `packages/box` and `packages/broker`
    (`packages/control-plane/scripts/check-box-image.mjs:15-41`). Its canonical
    input set must include the full Lody subtree, adapter vendor area, lockfile,
    and build/seam scripts.
11. **The R2 release must be immutable, not only hash-checked.** The publisher
    currently uploads `part-*` and `manifest.json` to one shared logical prefix
    and prints one fixed manifest URL
    (`packages/control-plane/scripts/publish-box-image.mjs:306-317`,
    `packages/control-plane/scripts/publish-box-image.mjs:373-380`); the Worker
    serves only one path level (`packages/control-plane/core/box-images.ts:19-32`).
    Automated bakes need a release-keyed prefix so a publish cannot overwrite
    parts an in-flight bootstrap or rollback still names.
12. **The CI prerequisite is slightly larger than “Node plus tarball.”** The
    harness supplies its own TCP gateway and files stand-in and spawns the Node
    daemon and bridge itself (`packages/webapp/test/lody-daemon-harness.ts:447-543`),
    so ttyd, cloudflared, and the Go gateway are not needed. Most suites need a
    Linux runner, Node 22, repo dependencies, and a globally installed built
    tarball. `lody-post-signin-turn` additionally execs the real Claude binary at
    a fixed `/opt` path (`packages/webapp/test/lody-post-signin-turn.test.ts:16-21`,
    `packages/webapp/test/lody-post-signin-turn.test.ts:57-59`,
    `packages/webapp/test/lody-post-signin-turn.test.ts:131-155`), so make that
    binary path overridable and install the same Claude CLI used by the image.
13. **The bridge guest tests are not daemon-pair tests.** They intentionally run
    the real bridge or registrar against stand-in daemon sockets; the registrar
    suite says it needs neither a Lody bundle nor a network
    (`packages/box/guest-tests/test/lody-projects-registration.test.ts:1-18`).
    Keep them in the gate because they protect the boundary, but do not count
    them as evidence that the built daemon starts.
14. **A new box image does not update the field automatically.** The cloud-VM
    host polls box config and replaces its container only for a requested update;
    the microVM provider has no update path (`packages/control-plane/core/box-config.ts:21-29`).
    Automatic canary publication changes the configured image and new boxes;
    existing cloud boxes still require the update request. Do not silently turn
    a Lody merge into a fleet-wide process-killing replacement.

## Pin and adapter materialization

### One readable Lody revision

Change `vendor/lody/UPSTREAM.md` to record:

- `Pinned commit`: the 40-character upstream SHA;
- `Subtree squash commit`: the 40-character Blitz commit whose body carries
  `git-subtree-dir: vendor/lody` and the matching `git-subtree-split` SHA; and
- no npm `lody` field, candidate lookup, lag explanation, or verified-pair
  language.

Add `scripts/lody-pin.mjs`. It scans reachable history for the newest matching
subtree trailer rather than assuming the newest commit touching `vendor/lody`
is the squash commit. That assumption is already false because later declared
seam commits also touch the subtree, while the current runbook uses a
single-latest-commit lookup (`docs/LODY-MERGE.md:70-92`). The script exports the
pin parser to the build, Vite, drift tests, and merge automation; there is one
implementation of the rule.

`test/lody-pin-provenance.test.mjs` fails unless:

1. the upstream SHA in `UPSTREAM.md` equals the squash commit's
   `git-subtree-split` value;
2. the recorded squash commit is reachable and carries
   `git-subtree-dir: vendor/lody`;
3. the five build-adapter SHAs in their stamps equal the five gitlink object IDs
   returned by `git ls-tree HEAD:vendor/lody/packages`;
4. Kimi is still a gitlink and still excluded by `pnpm-workspace.yaml`; and
5. the upstream-baseline README names the same upstream SHA. The existing seam
   test already performs only the last comparison
   (`packages/webapp/test/lody-seam-pin.test.ts:173-183`).

The stamp's `subtreeCommit` is the squash commit, not `HEAD` and not the
upstream SHA. “Pin equals marker equals stamp” therefore means two comparisons:
`UPSTREAM.upstreamSha == squash.git-subtree-split == BUILD.upstreamSha`, and
`UPSTREAM.subtreeCommit == BUILD.subtreeCommit`.

### Vendor five adapters outside the subtree

Add `scripts/lody-sync-adapters.mjs` and
`vendor/lody-adapters/{core,claude,codex,dsh,grok}/`.

| Upstream gitlink at `f4b1ba25` | Object ID | Build disposition |
|---|---|---|
| `acp-extension-core` | `23c792b910a903b74601e346473827106f991715` | vendor and overlay |
| `acp-extension-claude` | `d395b3dc69832c6566eb0da84a08486d16ba1e69` | vendor and overlay |
| `acp-extension-codex` | `0887c5620b7b1773fa401e65a1009f10f80715a7` | vendor and overlay |
| `acp-extension-dsh` | `c584a16e4f4ce982c762b2c11f0c344f1643fd6d` | vendor and overlay |
| `acp-extension-grok` | `77a994f4e0a5acec8c52020c0a8e01b0e90aaef9` | vendor and overlay |
| `acp-extension-kimi` | `aab809cca845e4b1d0a0db243d336ab5f128b177` | preserve gitlink; excluded from CLI workspace |

These are the object IDs returned by
`git ls-tree HEAD:vendor/lody/packages | grep acp-extension` in this worktree;
`UPSTREAM.md` independently inventories the six gitlink paths
(`vendor/lody/UPSTREAM.md:46-54`). The sync script always re-reads the object
IDs; this table records the migration input, not a second editable manifest.

The script:

1. reads repository URLs from `vendor/lody/.gitmodules`; those six public URLs
   are already recorded there (`vendor/lody/.gitmodules:1-18`);
2. reads the five required object IDs directly from the gitlinks;
3. fetches each public repository at exactly that object ID into a temporary
   directory, verifies `git rev-parse HEAD`, and copies only tracked files—never
   `.git` or build output—into `vendor/lody-adapters/<name>`;
4. writes a per-adapter `UPSTREAM.md` containing name, URL, 40-character commit,
   and a SHA-256 over sorted `path\0mode\0content` records; and
5. refuses a dirty destination unless `--check` proves it is already identical.

`test/lody-adapter-drift.test.mjs` is network-free. It compares each stamp to
the corresponding upstream gitlink, recomputes the reviewed tree hash excluding
the stamp, rejects symlinks that escape the adapter root, asserts there are
exactly five materialized build adapters, and asserts Kimi is neither copied
nor accidentally admitted to the workspace.

At build time, copy `vendor/lody` to `/src/lody`, remove the five empty gitlink
directories in that disposable copy, and copy the reviewed adapter trees into
their expected `packages/acp-extension-*` paths. The source checkout remains
unchanged.

Fetching adapters during every bake is rejected. It is fewer repository files,
but adds five availability dependencies to the most expensive CI step, hides
the adapter diff from code review, and makes an old image impossible to rebuild
after a repository disappears. Budget roughly 1-2 MiB and 1.3k tracked files
for the five current trees; the sync PR records the exact diff. That is an
acceptable price for reviewed, offline adapter inputs. `pnpm install` still
uses the npm registry, but its resolution is frozen by the lockfile; an adapter
Git host is no longer part of the bake.

## Build and package in the image

Add a `lody-build` stage to `packages/box/Dockerfile`, based on the same pinned
Node 22 image the current vendors/runtime stages use
(`packages/box/Dockerfile:25-25`, `packages/box/Dockerfile:61-61`). Use Corepack
for the package manager and run `corepack enable` before the build, because the
upstream build scripts invoke bare `pnpm` (`vendor/lody/apps/cli/package.json:13-20`)
and the spike failed until a Corepack shim existed
(`/var/lib/blitz/home/codex/daemonbuild-result.md:59-66`). The root
`packageManager` pins pnpm 10.20.0 plus its integrity hash
(`vendor/lody/package.json:73-80`).

The stage is:

```text
overlay five reviewed adapters into /src/lody
corepack enable
corepack pnpm install --filter 'lody...' --frozen-lockfile
corepack pnpm --filter lody build
copy THIRD_PARTY_NOTICES.md to apps/cli/dist/THIRD_PARTY_NOTICES.md
node /src/scripts/lody-dist-manifest.mjs --check apps/cli/dist
corepack pnpm --filter lody pack --pack-destination /out
node /src/scripts/lody-build-stamp.mjs --tarball /out/lody-*.tgz --out /out/BUILD.json
```

Use a BuildKit cache mount for the pnpm store, keyed by Node major, pnpm
version, lockfile digest, and build platform. Do not cache `node_modules` or
`dist`; both must be reconstructed from the frozen graph and current source.
The cold cost budget is the measured 2m11s plus Docker layer overhead, with
roughly 3.2 GB peak scratch. A warm adapter/source-only merge should reuse the
pnpm store and pay mainly the 91-second build
(`/var/lib/blitz/home/codex/daemonbuild-result.md:51-76`).

The tarball remains architecture-neutral JavaScript/WASM plus dependency
metadata. Install it in the target-platform `vendors` stage with
`npm install --global --omit=dev /out/lody-*.tgz`, beside the existing Claude,
Codex, and `ws` installs. npm then resolves external/native runtime packages for
the target architecture. Run a target-platform import/`--help` smoke after the
install. The final image still copies `/opt/blitz/npm` wholesale
(`packages/box/Dockerfile:131-147`), so the bridge, service graph, harness, and
shell PATH keep their paths.

The current s6 service invokes `/opt/blitz/npm/bin/lody start` directly
(`packages/box/rootfs/etc/s6-overlay/s6-rc.d/lody-daemon/run:46-52`), and the
watchdog probes the health socket and restarts the s6 service
(`packages/box/rootfs/etc/s6-overlay/s6-rc.d/lody-watchdog/run:44-68`). Neither
parses `lody --version`. Keep the upstream `0.76.0` package version unchanged;
rewriting it would create another version claim. Remove stale comments that say
the service needs a compiled npm-bundle patch
(`packages/box/rootfs/etc/s6-overlay/s6-rc.d/lody-daemon/run:11-15`).

Write `/opt/blitz/lody/BUILD.json` with this shape:

```json
{
  "upstreamSha": "<40 hex>",
  "subtreeCommit": "<40 hex>",
  "adapterShas": {
    "core": "<40 hex>",
    "claude": "<40 hex>",
    "codex": "<40 hex>",
    "dsh": "<40 hex>",
    "grok": "<40 hex>"
  },
  "lockfileSha256": "<64 hex>",
  "distSha256": "<64 hex>",
  "builtAt": "<ISO-8601 UTC>",
  "node": "22.20.0",
  "pnpm": "10.20.0"
}
```

`distSha256` is the hash of sorted `path\0sha256\n` records for every packed
`package/dist` file, not only `index.js` and not the gzip tarball. That makes it
stable across tar metadata and covers code-split output. `builtAt` is provenance
only and is excluded from `distSha256` and the image-input release ID; the plan
does not claim byte-for-byte reproducibility, which the spike did not test
(`/var/lib/blitz/home/codex/daemonbuild-result.md:114-123`). Make the file
root-owned, mode 0444, and copy it independently of the npm prefix so CLI
self-updates cannot rewrite provenance.

### Source seam and deletions

Add one declared daemon seam to
`vendor/lody/apps/cli/src/lib/message-processor.ts`: route only
`machine/acp-authenticate` `action: "start"` onto
`acp-auth:<agentType>`; submit/cancel remain on the default chain. The defect is
still present because the switch names session messages and otherwise returns
`null` (`vendor/lody/apps/cli/src/lib/message-processor.ts:196-220`), while
`ConcurrentQueue` turns every `null` into one serial `__default__` chain
(`vendor/lody/apps/cli/src/lib/concurrent-queue.ts:23-35`). Record the source
hunk, rationale, conflict drill, and upstream-PR sketch in
`vendor/lody/BLITZ-PATCHES.md`.

Add `vendor/lody/apps/cli/src/lib/message-processor.test.ts`. Hold a start
handler open, enqueue submit-code and cancel, and prove both execute before the
start is released; prove two starts for one agent serialize and starts for two
agents may proceed independently. Extend
`packages/webapp/test/lody-seam-pin.test.ts` and its pristine baseline mechanism
to anchor the CLI source hunk as well as renderer seams. The current helper is
hard-coded to the components tree (`packages/webapp/test/upstream-seam-pin.ts:32-55`),
so first parameterize its upstream root.

Delete all three compiled-bundle scripts and their Docker/harness invocation:

- `packages/box/patches/lody-local-platform.mjs`: source already hardcodes the
  public bundle to local mode (`vendor/lody/apps/cli/vite.config.ts:11-18`);
- `packages/box/patches/lody-code-collab-worktree-root.mjs`: source now detects
  local worktrees, uses the worktree path, waits while one is being prepared,
  and never falls back to the shared clone
  (`vendor/lody/apps/cli/src/lib/message-handler.ts:6234-6311`); and
- `packages/box/patches/lody-acp-auth-queue.mjs`: its behavior is now tested at
  source instead of rewritten into compiled output. The current script's
  version/anchor patch is exactly the behavior being moved
  (`packages/box/patches/lody-acp-auth-queue.mjs:23-39`,
  `packages/box/patches/lody-acp-auth-queue.mjs:54-78`).

Remove the npm pin from the global install, the three Docker `COPY`/patch
commands, `PATCH_SCRIPTS` and the patch loop from the harness. Today those are
duplicated in both places (`packages/box/Dockerfile:44-59`,
`packages/webapp/test/lody-daemon-harness.ts:65-74`,
`packages/webapp/test/lody-daemon-harness.ts:454-468`).

## Pair identity at connect

### Box route

Add `GET /build` to `blitz-lody-bridge`. It reads the immutable stamp path from
`BLITZ_LODY_BUILD_STAMP` (default `/opt/blitz/lody/BUILD.json`), validates the
fixture-pinned shape, and serves the exact canonical JSON with `cache-control:
no-store`. A missing stamp answers 404 with
`{"ok":false,"error":"lody_build_unavailable"}`; malformed or unreadable
answers 503 and never leaks file-system details.

Expose it as `/lody/build` through:

- `packages/box/gateway/main.go` and its exact `lodyPaths` allowlist, which today
  lists only sync, RPC, control, project, and platform
  (`packages/box/gateway/main.go:39-43`, `packages/box/gateway/main.go:75-84`);
- `packages/schema/src/webapp-surface.ts`, whose browser allowlist likewise
  names exactly five Lody doors (`packages/schema/src/webapp-surface.ts:12-22`);
  and
- owned and shared endpoint construction in the webapp/harness. Build metadata
  is public image provenance, so an otherwise valid shared claim may read it;
  ordinary workspace viewers retain the gateway's existing Lody-door refusal.

Do not touch the body semantics of `/lody/platform`.

### Browser comparison

`scripts/lody-pin.mjs` also supplies a Vite config helper. `vite.config.ts`
defines a typed `__BLITZ_LODY_UPSTREAM_SHA__` from `UPSTREAM.md` at build time;
the browser never fetches repository metadata. A drift test invokes the same
helper and proves the compiled constant, pin parser, and subtree trailer agree.
This fits the existing Vite config, which already executes Node-side derived
configuration before the browser build (`packages/webapp/vite.config.ts:27-52`).

Fetch `/lody/build` beside the first successful platform snapshot. Compare only
`upstreamSha`; the adapter and lockfile fields are diagnostic and are already
bound to that upstream tree by the pin gates. On mismatch, emit once per surface:

```text
console.warn("lody_pair_skew", {
  expectedUpstreamSha,
  actualUpstreamSha,
  boxDistSha256,
  boxSubtreeCommit
})
```

Render one non-blocking hint above the session surface: “This box and the app
run different Lody builds. Update the box to match.” It must not label either
side newer. The update action may call the existing session-authenticated box
update route, which exists but has no webapp consumer yet
(`packages/control-plane/core/box-config.ts:150-180`). Refreshing the app is also
offered before replacing a running box. A 404/no stamp is the legacy npm-daemon
transition state: no skew event, no blocking, and at most a debug log. A malformed
present stamp is an operator error and gets a structured error plus the same
non-blocking hint.

This comparison intentionally detects upstream-pair skew, not every Blitz-only
renderer seam edit at the same upstream SHA. Those edits are covered by the CI
pair gate and image-input hash below; making the connect contract hash every
renderer source file would create false fleet skew for presentation-only seams.

### Fixture corpus

Add `packages/schema/fixtures/lody-build/` with canonical matching, skewed,
extra-field, missing-field, malformed-hash, and legacy-absent cases. Update the
cross-runtime table in `CLAUDE.md` with these sides:

```text
Docker/Node stamp producer -> node bridge -> Go gateway -> browser parser/comparator
```

Conformance is:

- `packages/box/guest-tests/test/lody-build-contract.test.ts`: runs the real
  stamp generator and bridge against every fixture, including missing/malformed;
- `packages/box/gateway/main_test.go`: proves the new exact path, method, role,
  share-header, and pass-through behavior without widening `/lody/*` generally;
  and
- `packages/webapp/test/lody-build-contract.test.ts`: consumes the same valid
  and invalid fixtures, pins the once-only `lody_pair_skew` fields, legacy
  tolerance, and exact non-blocking copy.

## CI pair gate

The daemon suites currently skip whenever the one hard-coded box path lacks
`dist/index.js` (`packages/webapp/test/lody-daemon-harness.ts:65-82`), and the
runbook explicitly accepts that CI state (`docs/LODY-MERGE.md:428-437`). Change
the declaration to:

```ts
export const LODY_BUNDLE = process.env.LODY_BUNDLE
  ?? "/opt/blitz/npm/lib/node_modules/lody";
```

Add the equivalent `LODY_CLAUDE_BINARY` override to
`lody-post-signin-turn.test.ts`; keep the box paths as defaults. Do not add a
second harness.

The `lody-daemon` CI job on `ubuntu-latest` performs the same overlay, frozen
install, build, output check, notice copy, pack, and stamp steps as the
Dockerfile through one shared `scripts/lody-build-package.mjs`. It installs the
tarball with `npm install --global --prefix "$RUNNER_TEMP/lody"`, exports
`LODY_BUNDLE=$RUNNER_TEMP/lody/lib/node_modules/lody`, and installs the image's
Claude CLI for the post-sign-in signed-out cases. Node comes from the repository
engine constraint (`package.json:16-18`); Corepack selects the vendored pnpm
version. Upload the tarball and stamp as workflow artifacts so matrix jobs test
the exact bytes the build job produced.

Run every non-probe file that imports `lody-daemon-harness.ts`, one file per
matrix runner so the daemon's single-host lease does not serialize unrelated
jobs. At minimum this includes:

- `lody-session-surface.test.tsx`, `lody-session-rail.test.tsx`, and
  `lody-post-signin-turn.test.ts`;
- ACP authentication, archive lifecycle, attachments, project-control frames,
  session roundtrip/workdir, shared endpoints/surface, sharing relay, worktree
  composer/session, and the remaining harness consumers; and
- the three `lody-bridge-*` guest suites plus
  `lody-projects-registration.test.ts` as boundary gates. They can run in the
  existing JavaScript job because they use stand-ins.

Keep `BLITZ_LODY_LIVE_TURN` unset. The paid cases already skip unless it is
explicitly enabled (`packages/webapp/test/lody-session-surface.test.tsx:14-24`,
`packages/webapp/test/lody-post-signin-turn.test.ts:23-28`). Run the two-daemon
`lody-keepalive-activation.probe.test.tsx` only on a scheduled/manual performance
workflow: it is useful pair evidence but not a deterministic PR correctness
gate. `lody-switch-cost.probe.test.tsx` remains opt-in measurement for the same
reason.

### Fixture provenance under the source-built daemon

Re-capture the daemon-authored portions once from the first production-shaped
build at `f4b1ba25`, then validate them on every later merge:

- `lody-data-plane/server/*`, except its two documented synthesized cases, and
  retain the documented derived chunked frame
  (`packages/schema/fixtures/lody-data-plane/README.md:29-46`);
- `lody-project-registration/request/*` and `response/*`
  (`packages/schema/fixtures/lody-project-registration/README.md:29-38`);
- the non-synthesized stream/envelope cases in
  `lody-session-control-stream`
  (`packages/schema/fixtures/lody-session-control-stream/README.md:43-65`); and
- `lody-share-claim/catalog-full.json`, then regenerate
  `catalog-shared.json` through the bridge projection
  (`packages/schema/fixtures/lody-share-claim/README.md:26-42`).

Replace each side-table entry “`lody@0.88.1`, not in this tree” and each capture
sentence with “captured from the daemon built from `vendor/lody` at
`<upstreamSha>` (`distSha256` `<sha>`)”. Do not churn genuine IDs on every merge.
`scripts/lody-validate-fixtures.mjs` starts the just-built daemon, drives the
capture scenarios, normalizes only documented nondeterministic IDs/timestamps,
and fails on a semantic difference. Re-capture and change the provenance SHA
only when the reviewed protocol behavior actually changes. Today the three
corpora explicitly name the old npm daemon
(`packages/schema/fixtures/lody-data-plane/README.md:18-36`,
`packages/schema/fixtures/lody-project-registration/README.md:12-38`,
`packages/schema/fixtures/lody-session-control-stream/README.md:27-51`).

Land the CI job as `continue-on-error: true` first, require one green week and a
green source-built box smoke, then make it a required check before deleting the
verified-pair rule.

## Merge automation and canary bake

### `npm run lody:merge`

Add `"lody:merge": "node scripts/lody-merge.mjs"` at the root. The command
requires a clean worktree, refuses `main`, accepts `--ref <release-tag|main>`,
and performs current runbook sections 1 and 2 mechanically. Those sections are
currently manual fetch/diff/subtree instructions
(`docs/LODY-MERGE.md:33-98`).

The script:

1. resolves the ref to a 40-character public upstream commit and fetches enough
   history to preserve the subtree trailer;
2. records upstream commits since the old pin and intersects changed files with
   a machine-readable seam-path manifest used by `lody-seam-pin`;
3. runs `git subtree pull --prefix vendor/lody <public-url> <sha> --squash`;
4. on a conflict, stops without staging a guessed resolution and writes a
   report under `.git/lody-merge/` with conflicted files, seam ownership, and
   the relevant `BLITZ-PATCHES.md` conflict drill. A scheduled merge agent may
   resolve it and resume with `--continue`; the script itself never chooses
   product behavior;
5. runs `lody-sync-adapters`, updates the pin/squash fields in `UPSTREAM.md`,
   refreshes every pristine upstream baseline, and normalizes the expected
   `dist` manifest from the new build;
6. runs adapter drift, pin provenance, source seam pins, the focused upstream
   CLI seam test, the package build gates, fixture validation, and daemon-backed
   pair CI locally or in the opened PR;
7. generates a PR body with old/new commits, merged commit list, adapter changes,
   every seam file touched, deleted seams, and an A/B/C table: A = upstream now
   supplies the behavior and Blitz deletes its seam; B = behavior remains and
   only the declared source anchor moved; C = semantic conflict requiring an
   explicit resolution; and
8. commits generated material, pushes the automation branch, and opens the PR.
   It never enables auto-merge and never calls `gh pr merge`.

Prefer an upstream release tag when it contains the required changes. `main` is
allowed because upstream sometimes has no corresponding public release, but the
generated PR marks it `UNRELEASED UPSTREAM` and requires the full pair matrix.
A scheduled agent can run the command and prepare the PR; the sole routine human
action is reviewing and clicking merge. A genuine class-C decision can still
stop that automation—“one click” must not mean silently resolving a semantic
conflict.

Rewrite `docs/LODY-MERGE.md` around this command and recovery path. Delete its
§3 npm verified-pair procedure (`docs/LODY-MERGE.md:100-125`) and §5 compiled
npm-artifact patch audit (`docs/LODY-MERGE.md:237-327`). Keep the source-seam
reconciliation, dependency audit, workaround mirrors, gates, and explicit merge
approval, but make the command output their checklist and PR table. Remove
CLAUDE.md's “one verified pair” paragraph and compiled-patch bullet
(`CLAUDE.md:117-131`); replace them with the numbered invariants and new
`lody-build` contract.

### Exact canary workflow change

Add `scripts/box-image-inputs.mjs`. It hashes sorted Git mode/blob/path records
for every tracked input copied or compiled by `packages/box/Dockerfile`, including
`packages/box/**`, `packages/broker/**`, `packages/schema/fixtures/**`,
`env.defaults`, `vendor/lody/**`, `vendor/lody-adapters/**`, and the Lody
build/seam scripts. Its JSON report explicitly includes `upstreamSha`,
`subtreeCommit`, all five adapter SHAs, the `pnpm-lock.yaml` blob/digest, and the
daemon seam source blobs. Hashing the full Lody tree is deliberate: an upstream
renderer-only change still denotes a new renderer/daemon pair.

In `.github/workflows/canary.yml`:

1. add an `image` job, on the existing `canary` environment and under the
   existing non-cancelling concurrency group;
2. check out `main`, set up Buildx, derive
   `blitz-box:lody-<first16(inputSha256)>`, and check the immutable release URL;
3. if that release exists, return its ref/tag/archive SHA without rebuilding;
   otherwise build `linux/amd64` with GitHub Actions layer caching and
   `BLITZ_LODY_SESSIONS_DEFAULT=1`, run the Lody image smoke, and publish it to
   R2 under `box-image/releases/<inputSha256>/`;
4. extend `publish-box-image.mjs` with `--release` and `--json`/GitHub-output
   modes, reject overwriting an existing release, upload parts before its
   manifest, and extend `core/box-images.ts` with an exact validated release-key
   route while retaining the legacy fixed route; and
5. make `deploy` need `image`, remove the stale-image advisory and hard-coded
   `BLITZ_DEPLOY_VAR_BOX_IMAGE_*` lines, and pass the image job's immutable
   `ref`, `tag`, and archive SHA as those three deploy variables.

The build argument replaces the current untracked `sed` required to enable the
daemon in a canary image (`docs/BOX-IMAGE.md:63-82`). Default it to `0` so forks
and client prod retain current policy unless their release explicitly changes
it. The archive stays amd64 because canary currently offers only x86 machine
types (`docs/BOX-IMAGE.md:111-116`). The content-derived tag is a cache/release
identity, not a byte-reproducibility claim: the R2 archive SHA remains the
authoritative byte pin.

The result of a vendor PR merge is: new input hash -> cold/warm image bake ->
immutable R2 release -> canary Worker deploy pinned to that exact archive. No
follow-up pin commit exists. Existing cloud boxes are updated only when a member
or admin requests replacement; new boxes use the new pin immediately.

`release.yml` inherits the daemon build without Lody-specific orchestration
because it already builds `packages/box/Dockerfile` for amd64 and arm64 and pins
client prod to the resulting immutable GHCR digest
(`.github/workflows/release.yml:45-57`, `.github/workflows/release.yml:71-85`,
`.github/workflows/release.yml:119-145`). Add `cache-from/cache-to: type=gha`
there. Each target-platform vendors stage installs native dependencies and runs
the target smoke; the shared source package remains one logical build.

## Guardrails

Every item below is a named failing gate, not a review reminder.

| Gate | Fails when |
|---|---|
| `lody-adapter-drift.test.mjs` | one of the five vendored trees, stamps, URLs, or gitlink SHAs differs; Kimi is materialized or ceases to be explicitly excluded |
| `lody-pin-provenance.test.mjs` | `UPSTREAM.md`, reachable squash trailer, baselines, adapter stamps, or generated stamp inputs disagree |
| **Lody frozen install** | `corepack pnpm install --filter 'lody...' --frozen-lockfile` wants to rewrite the lock or cannot resolve the reviewed graph |
| **Lody published-bundle imports** | upstream's build drops or fails `check:published-bundle-imports`; that script already checks workspace imports and runtime dependency smoke (`vendor/lody/apps/cli/scripts/check-published-bundle-imports.js:55-103`) |
| `lody-dist-manifest.test.mjs` | packed output differs from the reviewed normalized set: fixed entry/ACP/worker JS names, exactly the expected normalized hashed chunks, DSH preset paths, `zstd.wasm`, license/readme/manifest, or notice; unlisted files also fail |
| `lody-notices.test.mjs` | `package/dist/THIRD_PARTY_NOTICES.md` is absent, empty, or differs byte-for-byte from the root notice; the current research tar omitted it (`/var/lib/blitz/home/codex/daemonbuild-result.md:119-123`) |
| extended `lody-seam-pin.test.ts` + `message-processor.test.ts` | the ACP source anchor moves, undeclared source is removed, or submit/cancel again serialize behind an interactive start |
| **Lody built-image smoke** | inside the just-built image, `lody --help` fails; the stamp disagrees with `UPSTREAM.md`; s6 cannot start the enabled daemon; its health socket fails; `/lody/platform` or `/lody/build` fails; or the served stamp differs from disk |
| `lody-build-contract.test.ts` on guest/gateway/webapp | any Docker/Node/Go/browser side accepts, rejects, forwards, compares, logs, or renders a fixture differently |
| **Lody daemon pair matrix** | a non-paid daemon-backed suite skips for lack of a bundle or fails against the tarball built from the PR's own tree |
| **Canary image inputs** | an upstream SHA, adapter SHA, lockfile, source seam, or Docker input changes without changing the derived image release ID |

The expected-dist manifest normalizes only Vite's content hash suffix. It still
requires every logical chunk prefix and count, all nine fixed JS entry/worker
files, all current preset files, and the WASM/notice. This is intentionally
sensitive: upstream uses multiple explicit worker inputs and hashed chunk output
(`vendor/lody/apps/cli/vite.config.ts:68-99`), and shipping only `index.js` is
known broken (`/var/lib/blitz/home/codex/daemonbuild-result.md:121-124`). A
legitimate code-splitting change updates this reviewed manifest in the vendor PR.

### Deliberately not guarded

- **`lody --version` matching a release.** Upstream source says `0.76.0`
  (`vendor/lody/apps/cli/package.json:1-9`); the immutable build stamp is the
  identity, and no s6/bridge/watchdog path parses CLI version output.
- **Byte-identical rebuilds.** Only input identity, packed file set/content hash,
  and the published archive SHA are promised. `builtAt` and the intentionally
  floating Claude CLI already prevent a useful whole-image byte-reproducibility
  claim; Claude is explicitly unpinned today (`packages/box/Dockerfile:27-37`).
- **Paid model turns in PR CI.** They spend a member subscription and already
  require an explicit opt-in. Free protocol, sign-out, lifecycle, and daemon
  behavior remain required.
- **All upstream behavior.** The gates cover Blitz seams, boundary contracts,
  package completeness, and representative real-daemon flows—not an exhaustive
  reimplementation of Lody's own test suite.
- **Automatic class-C conflict resolution or merge.** A stopped automation is
  safer than an invented product decision, and main deploys canary immediately.
- **Canary arm64.** R2 mode is single-architecture and canary's catalog is x86;
  client-prod tags still exercise both architectures.
- **Automatic field-box replacement.** Container replacement kills every
  running process, so box config remains request-gated. Pair skew makes the need
  visible without taking that authority.
- **A microVM in-place upgrade.** No such lifecycle exists; an old microVM must
  be destroyed/recreated until that provider gains box-config support.

## Risks and mitigations

| Risk | Consequence and mitigation |
|---|---|
| Unreleased upstream `main` | A same-commit pair can still contain unreleased regressions. Prefer public release tags; label a main snapshot; require the pair matrix; bake to canary before any `v*` client-prod tag. The existing release split is R2 canary versus tagged GHCR prod (`CLAUDE.md:218-227`). |
| Build time and disk | Cold bake adds about 2m11s and peaked near 3.2 GB. Cache only the pnpm store, preserve a warm BuildKit/GHA cache, and keep the build in its own stage so unrelated runtime layers do not invalidate it. |
| Native dependencies / architectures | `cpu-features` and `ssh2` optional accelerators warned in the spike, and another Node ABI/architecture may lack a prebuild (`/var/lib/blitz/home/codex/daemonbuild-result.md:59-66`, `/var/lib/blitz/home/codex/daemonbuild-result.md:119-123`). Install external runtime dependencies in each target stage and run the import/help smoke under both release platforms; add a compiler only if a required dependency proves it needs one. |
| Adapter repository size | Budget about 1-2 MiB and 1.3k files at this pin. Sync only tracked source, never histories or build output; the drift hash makes the exact size and accidental growth visible in the PR. |
| Stale CLI version | Operators may see `0.76.0` from a much newer source build. Always log/display upstream SHA plus `distSha256`; do not infer compatibility from semver. |
| Licenses | Bundled workspace and adapter code makes the root notice set part of the distributed package. Copy it into `dist`, pin it byte-for-byte, and review adapter license/stamp changes in every sync. |
| First field migration | Legacy npm boxes have no stamp and remain usable. A cloud VM can be moved through the request-gated box-config v1 updater; it polls, replaces the container, and reports the installed ref (`packages/control-plane/core/box-config.ts:21-29`, `packages/control-plane/core/box-config.ts:126-180`). A microVM cannot update in place, so it keeps the old npm daemon until recreation. Correct `docs/BOX-IMAGE.md:251-264`, whose “never upgrades” text predates box config v1. |
| Immutable R2 storage growth | Release-keyed objects accumulate. Apply a lifecycle policy only after the maximum rollback/field-update window, and never delete the release currently reported by canary or any pending box update. |

## Migration sequence

Each PR can ship on its own; the first check is deliberately advisory until the
image and migration pieces are ready.

### PR A — prove the pair in CI (small, about 150-250 lines)

- Touch `packages/webapp/test/lody-daemon-harness.ts`,
  `packages/webapp/test/lody-post-signin-turn.test.ts`,
  `.github/workflows/ci.yml`, and add the initial shared
  `scripts/lody-build-package.mjs`.
- Add `LODY_BUNDLE`/`LODY_CLAUDE_BINARY` overrides and an artifact-producing
  daemon build plus test matrix as `continue-on-error: true`.
- Temporarily materialize the five exact gitlink SHAs in CI scratch space; do
  not change the shipping image or delete any npm patch yet.
- Evidence: all non-paid real-daemon suites run instead of skip, and the built
  tarball/stamp are retained for inspection.

### PR B — make adapter inputs reviewed (medium data, small code)

- Add `vendor/lody-adapters/<five trees>` plus five stamps,
  `scripts/lody-sync-adapters.mjs`, `test/lody-adapter-drift.test.mjs`, and root
  package scripts.
- Switch the shared builder from network materialization to the overlay. Assert
  Kimi remains an excluded gitlink.
- Expected footprint: about 1.3 MiB / 1,285 upstream files plus 150-250 lines of
  sync/drift code. Delete the temporary CI fetch path.

### PR C — ship the source-built daemon (medium, about 300-450 net lines)

- Touch `packages/box/Dockerfile`, `vendor/lody/UPSTREAM.md`,
  `vendor/lody/BLITZ-PATCHES.md`, CLI `message-processor.ts`, source/baseline
  tests, s6 comments, harness comments, and the build/stamp/dist-manifest tests.
- Add the Corepack/frozen builder, package install, notice, stamp, target smoke,
  ACP queue source seam, and focused behavior test.
- Delete the npm `lody@0.88.1` install item, all three files in
  `packages/box/patches/`, all Docker patch steps, and the harness patch list and
  loop. Platform and Code Collab retain regression coverage, not patches.
- Make the advisory CI pair job required after the source-built image smoke is
  green.

### PR D — expose and compare the pair (medium, about 300-450 lines)

- Add `packages/schema/fixtures/lody-build/`; touch the bridge, gateway and Go
  tests, schema webapp surface, harness endpoints, Vite config/type declaration,
  platform fetch/surface UI, and guest/browser conformance tests.
- Add immutable stamp serving on `/lody/build`, the build-time upstream SHA,
  legacy tolerance, once-only structured skew log, and non-blocking update hint.
- Add the contract row to `CLAUDE.md`. Do not change `/lody/platform` bytes.

### PR E — automate upstream-to-canary (medium, about 350-500 lines)

- Add `scripts/lody-merge.mjs`, `scripts/lody-pin.mjs`, the machine-readable
  seam/input manifests and tests, and root `lody:merge` scripts.
- Touch `.github/workflows/canary.yml`, `.github/workflows/release.yml`,
  `check-box-image.mjs`, `publish-box-image.mjs`, `core/box-images.ts`, their
  tests, `docs/LODY-MERGE.md`, `docs/BOX-IMAGE.md`, `CLAUDE.md`, and
  `vendor/lody/UPSTREAM.md`.
- Add the content-derived, immutable R2 image job and pass its outputs into the
  deploy; add release BuildKit caching.
- Delete canary's manual stale-image advisory and three hard-coded R2 pins,
  runbook §§3/5, manual adapter/baseline mechanics now emitted by the command,
  and the verified-pair rule. Preserve the “never merge unattended” rule.

## What is simpler afterwards

- **Independent Lody core pins: 2 -> 1.** Remove one npm daemon pin; retain one
  upstream revision mirrored by a checked squash trailer. The inherited five
  adapter gitlink SHAs and lockfile are supply-chain inputs, not a second daemon
  selection.
- **Compiled-bundle patch scripts: 3 -> 0.** Remove all three scripts, three
  Docker copies/invocations, and the harness's duplicate three-entry patch path.
- **Brittle compiled-artifact guards: 7 -> 0.** Remove one published-bundle
  SHA-256 guard, three hard-coded npm-version guards, and three compiled-anchor
  occurrence guards. Replace them with one source anchor plus behavior,
  provenance, package-set, and image smoke tests.
- **Runbook sections devoted to selecting/patching npm: 2 -> 0.** Delete current
  §§3 and 5. Current §§1 and 2 also become one command rather than two manual
  procedures.
- **Manual canary image operations after a vendor merge: 5 -> 0.** Remove the
  separate build, untracked feature-flag edit, R2 publish, three-value source
  pin edit, and follow-up pin merge. The vendor PR's reviewed merge click starts
  the bake and deploy.
- **Runtime daemon paths changed: 0.** s6, watchdog, bridge, guest tests, shell
  PATH, and the webapp harness keep the installed path they already use.
