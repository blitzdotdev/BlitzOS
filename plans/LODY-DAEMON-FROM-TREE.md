# Build the Lody daemon from the vendored tree

Status: approved direction. Plan PRs A, B, and C are implemented. D and E are
still pending below. The release-input portion of E landed with C's review
follow-up. The target is one upstream Lody revision for both renderer and
daemon. No npm daemon release is selected independently.

## Decision and evidence

Before plan PR C, the box installed `lody@0.88.1` globally and copied that npm
tree into the runtime image. Five scripts rewrote its compiled `dist/index.js`
(`packages/box/Dockerfile:38-63`, `packages/box/Dockerfile:135-142`). The renderer
comes from the squashed public subtree. Before the 2026-09-04 documentation
migration, policy called that npm version plus the subtree revision one
verified pair. That former policy failed at the current pin: the new renderer
sends a capabilities-refresh shape that the old daemon rejects. The transition
and target rules now live in `docs/LODY-MERGE.md` and
`vendor/lody/UPSTREAM.md`.

Build the daemon from `vendor/lody/apps/cli` at the same upstream revision as
the renderer. The completed spike is sufficient evidence for the decision:

This design removes the step that rewrote a compiled daemon. It adds more
source-build, adapter, lock, stamp, and release-key tooling.

- after materializing five adapter gitlinks, the frozen install and build
  completed in 130.67 seconds. The build itself took 91.13 seconds
  (`/var/lib/blitz/home/codex/daemonbuild-result.md:35-57`);
- the output was a 5.7 MB tarball with a 59.9 MB development `dist`, and
  `check:published-bundle-imports` passed
  (`/var/lib/blitz/home/codex/daemonbuild-result.md:68-76`);
- `lody-session-surface`, `lody-session-rail`, and `lody-post-signin-turn`
  passed against that self-built daemon, including the capabilities-refresh
  regression (`/var/lib/blitz/home/codex/daemonbuild-result.md:80-94`);
- the public source already builds local mode and contains the Code Collab
  worktree fix. The ACP authentication queue fix is still needed
  (`/var/lib/blitz/home/codex/daemonbuild-result.md:96-110`); and
- the package version remains the stale `0.76.0`. Commit provenance, not
  `lody --version`, must identify the artifact
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
5. A source-built daemon enters an image only after every gate passes. Those
   gates cover pins, adapters, locks, bundles, output, notices, seams, and smoke.
6. A browser may connect across an old-box transition. It reports a pair skew
   and gives a non-blocking update hint; it does not refuse the session surface.
7. Every Blitz-authored build-provenance payload has one fixture corpus. Every
   producing, forwarding, and consuming runtime has conformance coverage, as
   required by `CLAUDE.md:59-63`.
8. A successful upstream-merge PR changes the canary image input identity. A
   merge to `main` builds, publishes, pins, and deploys that image without a
   second source commit.
9. No automation merges an upstream PR. The runbook's opening rule and “Open
   the pull request and stop” section make explicit approval mandatory
   (`docs/LODY-MERGE.md`).

## Corrections to the proposed shape

The direction holds, with these code-grounded corrections.

1. **One core revision, not literally one supply-chain pin.** The Lody revision
   is singular, but five adapter commit IDs and `pnpm-lock.yaml` remain required
   inputs. `UPSTREAM.md` is the human-readable pin; the reachable squash
   commit's `git-subtree-split` trailer is its integrity mirror. They must agree,
   not act as two independently editable pins. Before the 2026-09-04
   documentation migration, `vendor/lody/UPSTREAM.md` still carried an
   independent npm row and skew policy. It now records source and adapter pins
   plus the qualified transition state.
2. **There are six gitlinks, but only five CLI build inputs.** The checked tree
   has core, Claude, Codex, DSH, Grok, and Kimi gitlinks. The CLI declares and
   builds only the first five (`vendor/lody/apps/cli/package.json:13-20`,
   `vendor/lody/apps/cli/package.json:69-73`), while the workspace explicitly
   excludes Kimi (`vendor/lody/pnpm-workspace.yaml:1-5`). Preserve and validate
   the Kimi gitlink, but do not materialize it for the CLI build.
3. **Do not replace gitlinks inside the subtree.** Ordinary directories would
   make the next pull reconcile five directory/gitlink type changes. That
   violates the declared-seam-only rule (`vendor/lody/UPSTREAM.md:3-6`). Put
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
   response is byte-for-byte daemon catalog data
   (`packages/box/rootfs/usr/local/libexec/blitz-lody-bridge:20-44`,
   `packages/box/guest-tests/test/lody-bridge-frames.test.ts:245-249`). Shared
   requests already have a separately fixture-pinned projection
   (`packages/box/guest-tests/test/lody-bridge-share.test.ts:370-383`). A build
   field would silently turn the owner response into a Blitz-authored envelope.
7. **The control-plane version report cannot identify a running box.** It has
   `commit`, `boxImageRef`, and `migration`, not `boxImageTag`, and the image ref
   comes from deployment configuration (`packages/control-plane/core/version.ts:17-45`).
   It says what a new box would boot, not what answered this browser request.
8. **A SHA mismatch does not prove which side is older.** Commit IDs have no
   ordering in the browser. The hint must say, “This box and the app run
   different Lody builds. Update the box to match.” It must not claim which
   side is older. “Restart to update” is also inaccurate. Cloud-VM replacement happens
   only after `updateRequested` is set (`packages/control-plane/core/box-config.ts:21-29`,
   `packages/control-plane/core/box-config.ts:142-180`).
9. **Correction after #204 (2026-09-04): canary already has the image job and
   release hash.** Every push to `main` runs `gate`, then `image`, then `deploy`.
   The image job plans a content-derived release. It reuses a valid manifest or
   builds and publishes one. It passes the exact pin to deploy
   (`.github/workflows/canary.yml:22-185`, `.github/workflows/canary.yml:187-306`).
   PR E adds the merge command and workflow caching. It does not add the job.
10. **The image identity now covers pure Lody subtree merges.**
    `BOX_IMAGE_INPUTS` is the shared input list for the planner and advisory.
    It includes every repository source copied by the Dockerfile. The Lody
    tree, adapter vendor area, and all build scripts are included. A contract
    test parses `COPY` instructions and rejects an uncovered source. The key
    uses Git object IDs, so adapter trees and Lody gitlinks stay fast.
11. **Canary R2 releases already use immutable namespaces.**
    `box-image-key.mjs` hashes every `BOX_IMAGE_INPUTS` object ID into a
    64-character release ID. It derives both
    `blitz-box:<releaseId>` and `box-image/<releaseId>`
    (`packages/control-plane/scripts/box-image-key.mjs:20-38`). The planner
    accepts only a valid manifest with that exact tag. The publisher writes all
    parts before `manifest.json`. The Worker retains validated release-keyed
    routes beside legacy routes
    (`packages/control-plane/scripts/plan-box-image.mjs:39-83`,
    `packages/control-plane/scripts/publish-box-image.mjs:315-420`,
    `packages/control-plane/core/box-images.ts:24-56`). Lody input coverage is
    complete. PR E retains merge automation and workflow caching.
12. **The CI prerequisite is larger than “Node plus tarball.”** The harness
    supplies its own TCP gateway and files stand-in. It also spawns the Node
    daemon and bridge (`packages/webapp/test/lody-daemon-harness.ts:447-543`).
    Ttyd, cloudflared, and the Go gateway are unnecessary. Most suites need a
    Linux runner, Node 22, repository dependencies, and an installed tarball.
    The `lody-post-signin-turn` suite also executes the real Claude binary.
    Its default path is under `/opt`
    (`packages/webapp/test/lody-post-signin-turn.test.ts:16-21`,
    `packages/webapp/test/lody-post-signin-turn.test.ts:57-59`,
    `packages/webapp/test/lody-post-signin-turn.test.ts:131-155`). Make that
    path overridable. Install the same Claude CLI used by the image.
13. **The bridge guest tests are not daemon-pair tests.** They run the real
    bridge or registrar against stand-in daemon sockets. The registrar suite
    needs neither a Lody bundle nor a network
    (`packages/box/guest-tests/test/lody-projects-registration.test.ts:1-18`).
    Keep them because they protect the boundary. Do not count them as evidence
    that the built daemon starts.
14. **A new box image does not update the field automatically.** The cloud-VM
    host replaces its container only after a requested update. The microVM
    provider has no update path (`packages/control-plane/core/box-config.ts:21-29`).
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
subtree trailer. It does not assume the newest `vendor/lody` commit is the
squash. That assumption is already false because later declared
seam commits also touch the subtree. The current runbook searches every
reachable message for the matching trailer (`docs/LODY-MERGE.md`). The script
exports one shared parser to the build, Vite, drift tests, and merge
automation.

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
(`vendor/lody/UPSTREAM.md:43-50`). The sync script always re-reads the object
IDs; this table records the migration input, not a second editable manifest.

The script:

1. reads repository URLs from `vendor/lody/.gitmodules`; those six public URLs
   are already recorded there (`vendor/lody/.gitmodules:1-18`);
2. reads the five required object IDs directly from the gitlinks;
3. fetches each public repository at exactly that object ID into a temporary
   directory and verifies `FETCH_HEAD`;
4. excludes `dist/` and `node_modules/`, then copies the remaining tracked
   files into `vendor/lody-adapters/<name>` without `.git`; and
5. writes a per-adapter `UPSTREAM.md` with the name, URL, commit, commit date,
   and sync date.

The network-free check is
`packages/webapp/test/lody-adapters-drift.test.mjs`. It compares each stamp to
the corresponding gitlink and rejects unstaged checkout changes. It requires
all five package files and keeps Kimi excluded. The opt-in fetch check compares
the staged paths, modes, and bytes with exact upstream exports.

At build time, copy `vendor/lody` to `/src/lody`. Remove the five empty gitlink
directories from that disposable copy. Overlay the reviewed adapters at their
expected `packages/acp-extension-*` paths. The source checkout remains unchanged.

Fetching adapters during every bake would save repository files. It would add
five availability dependencies to the most expensive CI step. It would also
hide adapter diffs and prevent rebuilds after a repository disappears. Budget
roughly 1-2 MiB and 1.3k tracked files for the five current trees. The sync PR
records the exact diff. That is acceptable for reviewed, offline adapter inputs.
`pnpm install` still uses the npm registry. Its resolution is frozen by the
lockfile. Adapter Git hosts are not part of the bake.

## Build and package in the image

Add a `lody-build` stage to `packages/box/Dockerfile`. Base it on the same
pinned Node 22 image used by the vendors and runtime stages
(`packages/box/Dockerfile:25-25`, `packages/box/Dockerfile:61-61`). Use Corepack
and run `corepack enable` before building. Upstream invokes bare `pnpm`
(`vendor/lody/apps/cli/package.json:13-20`). The spike failed until a Corepack
shim existed
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
derive apps/cli/npm-shrinkwrap.json from the locked production graph
check the short required-runtime-asset manifest
corepack pnpm --filter lody pack --pack-destination /out
verify the tarball's stamp, shrinkwrap, production manifest, and dist digest
```

Use a BuildKit cache mount for the pnpm store, keyed by Node major, pnpm
version, and store format. The architecture-neutral tarball does not use the
target platform in its cache key. Do not cache `node_modules` or `dist`; both
must be reconstructed from the frozen graph and current source.
The cold cost budget is the measured 2m11s plus Docker layer overhead, with
roughly 3.2 GB peak scratch. A warm adapter/source-only merge should reuse the
pnpm store and pay mainly the 91-second build
(`/var/lib/blitz/home/codex/daemonbuild-result.md:51-76`).

The tarball remains architecture-neutral JavaScript/WASM plus dependency
metadata. Its npm lockfile v3 shrinkwrap comes from `apps/cli` production
dependencies in `pnpm-lock.yaml`. Every node records an exact version, registry
tarball URL, and integrity. Version conflicts use nested `node_modules` paths.

Extract the tarball in the target-platform `vendors` stage. Run `npm ci` at the
package root so npm enforces that shrinkwrap. This keeps platform selection and
native lifecycle handling on the target. Do not use `--ignore-scripts`.
`better-sqlite3` 13 carries platform prebuilds and has no install script. The
reviewed pnpm workspace marks its synthetic `binding.gyp` build as ignored.
Run a target-platform import and `--help` smoke after installation. The final
image still copies `/opt/blitz/npm` wholesale
(`packages/box/Dockerfile:131-147`), so the bridge, service graph, harness, and
shell PATH keep their paths.

The current s6 service invokes `/opt/blitz/npm/bin/lody start` directly
(`packages/box/rootfs/etc/s6-overlay/s6-rc.d/lody-daemon/run:46-52`). The
watchdog probes the health socket and restarts the service
(`packages/box/rootfs/etc/s6-overlay/s6-rc.d/lody-watchdog/run:44-68`). Neither
parses `lody --version`. Keep the upstream `0.76.0` package version unchanged;
rewriting it would create another version claim. Remove stale comments that say
the service needs a compiled npm-bundle patch
(`packages/box/rootfs/etc/s6-overlay/s6-rc.d/lody-daemon/run:11-15`).

Write `apps/cli/dist/BUILD.json` with this shape before packing:

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
  "node": "22.20.0",
  "pnpm": "10.20.0"
}
```

`distSha256` hashes sorted `path\0sha256\n` records for every packed
`package/dist` file except `BUILD.json`. It does not hash only `index.js` or the
gzip tarball. That makes it stable across tar metadata and covers
code-split output. Identical inputs produce identical stamp bytes because the
stamp has no build timestamp. Make the file mode 0444. The installed package's
`dist/BUILD.json` is the only image copy. Plan PR D serves that file directly.

### Source seam and deletions

Add one declared daemon seam to
`vendor/lody/apps/cli/src/lib/message-processor.ts`: route only
`machine/acp-authenticate` `action: "start"` onto
`acp-auth:<configId>`; submit/cancel remain on the default chain. At this pin the
source protocol replaced caller-supplied agent identity with a
daemon-authoritative persisted config ID. The authentication manager still
enforces its per-agent-type exclusion after resolving that config. The defect
is still present because the switch names only session messages. Otherwise it
returns `null` (`vendor/lody/apps/cli/src/lib/message-processor.ts:196-220`).
`ConcurrentQueue` turns every `null` into one serial `__default__` chain
(`vendor/lody/apps/cli/src/lib/concurrent-queue.ts:23-35`). Record the source
hunk, rationale, conflict drill, and upstream-PR sketch in
`vendor/lody/BLITZ-PATCHES.md`.

Add `vendor/lody/apps/cli/src/lib/message-processor.test.ts`. Hold a start
handler open. Prove submit-code and cancel execute before it is released. Prove
same-config starts serialize. Prove different-config starts may overlap. Extend
`packages/webapp/test/lody-seam-pin.test.ts` and its pristine baseline mechanism
to anchor the CLI source hunk as well as renderer seams. The current helper is
hard-coded to the components tree (`packages/webapp/test/upstream-seam-pin.ts:32-55`),
so first parameterize its upstream root.

The spike evaluated three compiled-bundle scripts that are now source or
upstream behavior:

- `lody-local-platform.mjs`: source already hardcodes the
  public bundle to local mode (`vendor/lody/apps/cli/vite.config.ts:11-18`);
- `lody-code-collab-worktree-root.mjs`: source now detects local worktrees and
  uses their path. It waits during preparation and never uses the shared clone
  (`vendor/lody/apps/cli/src/lib/message-handler.ts:6234-6311`); and
- `lody-acp-auth-queue.mjs`: its start-only behavior is tested at source instead
  of rewritten into compiled output.

Two more compiled-bundle scripts landed after the spike:
`lody-builtin-mcp-off.mjs` and `lody-session-sandbox.mjs`. PR C preserved their
behavior as default-inert source seams selected by s6. It then removed the npm
pin, five patch files, Docker commands, and duplicate harness patch path.

## Pair identity at connect

### Box route

Add `GET /build` to `blitz-lody-bridge`. It reads the immutable stamp path from
`BLITZ_LODY_BUILD_STAMP`. The default is
`/opt/blitz/npm/lib/node_modules/lody/dist/BUILD.json`. It validates the
fixture-pinned shape and serves canonical JSON with `cache-control: no-store`.
A missing stamp answers 404 with
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
  is public image provenance. A valid shared claim may read it. Ordinary
  workspace viewers retain the existing Lody-door refusal.

Do not touch the body semantics of `/lody/platform`.

### Browser comparison

`scripts/lody-pin.mjs` also supplies a Vite config helper. At build time,
`vite.config.ts` defines `__BLITZ_LODY_UPSTREAM_SHA__` from `UPSTREAM.md`. The
browser never fetches repository metadata. A drift test invokes the same
helper and proves the compiled constant, pin parser, and subtree trailer agree.
This fits the existing Vite config, which already executes Node-side derived
configuration before the browser build (`packages/webapp/vite.config.ts:27-52`).

Fetch `/lody/build` beside the first successful platform snapshot. Compare only
`upstreamSha`. The adapter and lockfile fields are diagnostic. The pin gates
already bind them to the upstream tree. On mismatch, emit once per surface:

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

This comparison detects upstream-pair skew, not every Blitz-only renderer seam
at the same upstream SHA. The CI pair gate and image-input hash cover those
edits. Hashing every renderer source would create false fleet skew.

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

The daemon harness first uses an explicit `LODY_BUNDLE`. Otherwise it accepts
the installed package only when `dist/BUILD.json` is present. An unstamped
legacy install and a missing install are unavailable. The suite prints one
line with the runbook build and export commands, then skips. CI sets
`LODY_REQUIRE_BUNDLE=1`, which turns unavailability into a test failure. The
workflow also rejects the diagnostic line. The harness never builds or caches
a daemon on demand.

The `lody-daemon` CI job uses the same shared builder as the Dockerfile. The
builder overlays adapters, installs, builds, checks output, copies notices,
packs, and stamps. It extracts the
tarball into a temporary prefix and runs `npm ci` at the package root. It then
exports `LODY_BUNDLE` for that exact package and installs the image's Claude
CLI for the post-sign-in signed-out cases. Node comes from the repository
engine constraint (`package.json:16-18`); Corepack selects the vendored pnpm
version. Upload the tarball and stamp as workflow artifacts so matrix jobs test
the exact bytes the build job produced.

Run every non-probe file that imports `lody-daemon-harness.ts`. Use one file per
matrix runner. The daemon's single-host lease must not serialize unrelated jobs.
At minimum this includes:

- `lody-session-surface.test.tsx`, `lody-session-rail.test.tsx`, and
  `lody-post-signin-turn.test.ts`;
- ACP authentication, archive lifecycle, attachments, project-control frames,
  session roundtrip/workdir, shared endpoints/surface, sharing relay, and
  worktree composer/session;
- the remaining harness consumers; and
- the three `lody-bridge-*` guest suites plus
  `lody-projects-registration.test.ts` as boundary gates. They can run in the
  existing JavaScript job because they use stand-ins.

Keep `BLITZ_LODY_LIVE_TURN` unset. The paid cases already skip unless it is
explicitly enabled (`packages/webapp/test/lody-session-surface.test.tsx:14-24`,
`packages/webapp/test/lody-post-signin-turn.test.ts:23-28`). Run the two-daemon
`lody-keepalive-activation.probe.test.tsx` only in a scheduled or manual
performance workflow. It is useful pair evidence, not a deterministic PR gate.
`lody-switch-cost.probe.test.tsx` stays opt-in for the same reason.

### Fixture provenance under the source-built daemon

Re-capture the daemon-authored portions once from the first production-shaped
build at `f4b1ba25`, then validate them on every later merge:

- `lody-data-plane/server/*`, except its two documented synthesized cases, and
  retain the documented derived chunked frame
  (`packages/schema/fixtures/lody-data-plane/README.md:34-49`);
- `lody-project-registration/request/*` and `response/*`
  (`packages/schema/fixtures/lody-project-registration/README.md:34-47`);
- the non-synthesized stream/envelope cases in
  `lody-session-control-stream`
  (`packages/schema/fixtures/lody-session-control-stream/README.md:48-70`); and
- `lody-share-claim/catalog-full.json`, then regenerate
  `catalog-shared.json` through the bridge projection
  (`packages/schema/fixtures/lody-share-claim/README.md:31-50`).

The side-table entries now distinguish the current transition from the target.
On the first source-built recapture, replace each historical capture sentence.
Use “captured from the daemon built from `vendor/lody` at `<upstreamSha>`
(`distSha256` `<sha>`)”. Do not churn genuine IDs on every merge.
`scripts/lody-validate-fixtures.mjs` starts the just-built daemon. It drives the
capture scenarios and normalizes documented nondeterministic values. It fails
on a semantic difference. Re-capture and change the provenance SHA
only when the reviewed protocol behavior actually changes. Today the three
corpora retain qualified historical capture sentences naming the old npm daemon
(`packages/schema/fixtures/lody-data-plane/README.md:34-46`,
`packages/schema/fixtures/lody-project-registration/README.md:34-48`,
`packages/schema/fixtures/lody-session-control-stream/README.md:48-60`).

The `lody-daemon` CI job is a required check, and PR C moved the same build into
the shipping image. The former verified-pair rule was removed from current
documentation on 2026-09-04.

## Merge automation and canary bake

### `npm run lody:merge`

Add `"lody:merge": "node scripts/lody-merge.mjs"` at the root. The command
requires a clean worktree and refuses `main`. It accepts
`--ref <release-tag|main>`. It performs branch preparation, seam inventory, and
the subtree pull. Those steps are currently manual (`docs/LODY-MERGE.md`).

The script:

1. resolves the ref to a 40-character public upstream commit and fetches enough
   history to preserve the subtree trailer;
2. records upstream commits since the old pin and intersects changed files with
   a machine-readable seam-path manifest used by `lody-seam-pin`;
3. runs `git subtree pull --prefix vendor/lody <public-url> <sha> --squash`;
4. on a conflict, stops without staging a guessed resolution. It writes a
   report under `.git/lody-merge/`. The report lists conflicts, seam ownership,
   and the relevant `BLITZ-PATCHES.md` drill. A scheduled merge agent may
   resolve it and resume with `--continue`; the script itself never chooses
   product behavior;
5. runs `lody-sync-adapters` and updates the pin fields in `UPSTREAM.md`. It
   refreshes pristine baselines and normalizes the expected `dist` manifest;
6. runs adapter drift, pin provenance, source seam pins, and the upstream seam
   test. It also runs build gates, fixture validation, and daemon-backed pair CI;
7. generates a PR body with commits, adapter changes, touched seam files, and
   deleted seams. Its A/B/C table records the resolution. Class A deletes a
   seam because upstream supplies it. Class B reanchors unchanged behavior.
   Class C requires an explicit semantic decision; and
8. commits generated material, pushes the automation branch, and opens the PR.
   It never enables auto-merge and never calls `gh pr merge`.

Prefer an upstream release tag when it contains the required changes. Upstream
`main` is allowed when no release contains them. The generated PR then says
`UNRELEASED UPSTREAM` and requires the full pair matrix. A scheduled agent can
prepare the PR. A human still reviews and clicks merge. A class-C decision can
stop that automation. “One click” must not mean silently resolving a semantic
conflict.

The 2026-09-04 migration rewrote `docs/LODY-MERGE.md` around this command and
recovery path. It removed the npm-pair procedure and compiled-artifact audit.
It retained seam reconciliation, dependency review, workaround mirrors, gates,
and explicit approval. `CLAUDE.md` likewise replaced its former “one verified pair” and
compiled-patch rules with current transition rules and the documentation map.
PR E can delete the manual mechanics that the command finally emits.

### Extend the existing canary workflow

PR #204 introduced `BOX_IMAGE_INPUTS`, the image key and planner, and the
canary image job. It also added versioned R2 routes and JSON publisher output.
Parts upload before the manifest. Deploy receives the exact pin. The
source-daemon follow-up expanded that list to every
Dockerfile repository input, including every Lody build input. Its release ID
is a SHA-256 over those Git object IDs. All 64 characters become the image tag
suffix and R2 namespace. A valid manifest is reused without rebuilding
(`packages/control-plane/scripts/lib/box-image-inputs.mjs`,
`packages/control-plane/scripts/box-image-key.mjs:20-38`,
`.github/workflows/canary.yml:48-185`).

The source-daemon review follow-up extended that mechanism. Input coverage is
complete and no longer belongs to PR E:

1. The key now covers `vendor/lody`, adapter snapshots, `pnpm-lock.yaml`, and
   every shared daemon build input.
2. The exact `box-image/<releaseId>/manifest.json` probe and reuse behavior stay
   unchanged. An absent release builds `linux/amd64` with
   `BLITZ_LODY_SESSIONS=1`. Lody image smoke runs before publication.
3. `publish-box-image.mjs --prefix ... --json ...` retains part-first upload.
   The validated release-key route and legacy fixed route remain unchanged.
4. `deploy` still depends on `image`. It receives the immutable `ref`, `tag`,
   and archive SHA. `/version` checks the commit and image tag.

PR E will add BuildKit workflow caching. It will consume the existing input
evidence rather than changing release identity again.

The build argument already replaced the old untracked `sed`
(`.github/workflows/canary.yml:109-116`). `env.defaults` remains off for forks
and self-hosters. Canary explicitly enables the daemon. The archive stays
amd64 because canary currently offers only x86 machine types
(`docs/BOX-IMAGE.md:106-108`). The content-derived tag is a cache/release
identity, not a byte-reproducibility claim: the manifest's archive SHA remains
the authoritative byte pin.

The vendor merge changes the input hash. The workflow reuses a valid release or
bakes an image. It publishes an immutable R2 release and pins canary to that
archive. #204 removed the follow-up pin commit. Existing cloud boxes are updated
only when a member or admin requests replacement; new boxes use the new pin
immediately.

`release.yml` inherits the daemon build without Lody-specific orchestration. It
already builds `packages/box/Dockerfile` for amd64 and arm64. Client production
uses the resulting immutable GHCR digest
(`.github/workflows/release.yml:45-57`, `.github/workflows/release.yml:71-85`,
`.github/workflows/release.yml:119-145`). Add `cache-from/cache-to: type=gha`
there. Each target-platform vendors stage installs native dependencies and runs
the target smoke; the shared source package remains one logical build.

## Guardrails

Every item below is a named failing gate, not a review reminder.

| Gate | Fails when |
|---|---|
| `lody-adapters-drift.test.mjs` | one of the five stamps, URLs, or gitlink SHAs differs; a package or snapshot is missing; the checkout differs from Git's index; Kimi is included; or Docker ignore rules exclude a builder input |
| `lody-pin-provenance.test.mjs` | `UPSTREAM.md`, reachable squash trailer, baselines, adapter stamps, or generated stamp inputs disagree |
| **Lody frozen install** | `corepack pnpm install --filter 'lody...' --frozen-lockfile` wants to rewrite the lock or cannot resolve the reviewed graph |
| **Lody published-bundle imports** | upstream's build drops or fails `check:published-bundle-imports`; that script already checks workspace imports and runtime dependency smoke (`vendor/lody/apps/cli/scripts/check-published-bundle-imports.js:55-103`) |
| `lody-build-package.test.mjs` | the shrinkwrap differs from the pnpm production graph, or packed output misses the CLI, a worker, WASM glue, presets, notice, stamp, or shrinkwrap |
| `lody-notices.test.mjs` | `package/dist/THIRD_PARTY_NOTICES.md` is absent, empty, or differs byte-for-byte from the root notice; the current research tar omitted it (`/var/lib/blitz/home/codex/daemonbuild-result.md:119-123`) |
| extended `lody-seam-pin.test.ts` + `message-processor.test.ts` | the ACP source anchor moves, undeclared source is removed, or submit/cancel again serialize behind an interactive start |
| **Lody daemon seam behavior** | the built scratch tree fails the focused ACP authentication queue, built-in-MCP request/reminder, or session-sandbox suites; this includes preserving external MCP servers and the upstream defaults when the host options are absent |
| **Lody built-image smoke** | inside the just-built enabled image, `lody --help` fails; the package stamp is missing; s6 cannot keep the daemon and bridge up; bridge health or `/lody/platform` fails; the daemon misses its selected MCP environment/log; or its live cgroup and prepared session parent violate the box boundary |
| `lody-build-contract.test.ts` on guest/gateway/webapp | any Docker/Node/Go/browser side accepts, rejects, forwards, compares, logs, or renders a fixture differently |
| **Lody daemon pair matrix** | a non-paid daemon-backed suite skips for lack of a bundle or fails against the tarball built from the PR's own tree |
| **Canary image inputs** | an upstream SHA, adapter SHA, lockfile, source seam, or Docker input changes without changing the derived image release ID |

The package manifest is a short required-runtime list. It requires the CLI,
workers, WASM glue, preset roots, the notice, and the stamp. It also requires
`package.json` and the shrinkwrap. It does not enumerate ordinary
hashed chunks or warn about additions. Shipping only `index.js` remains known
broken (`/var/lib/blitz/home/codex/daemonbuild-result.md:121-124`).

### Deliberately not guarded

- **`lody --version` matching a release.** Upstream source says `0.76.0`
  (`vendor/lody/apps/cli/package.json:1-9`); the immutable build stamp is the
  identity, and no s6/bridge/watchdog path parses CLI version output.
- **Byte-identical whole images.** Identical Lody inputs now produce identical
  stamp and runtime-lock bytes. Tar metadata and the intentionally floating
  Claude CLI still prevent a whole-image byte-reproducibility claim.
- **Paid model turns in PR CI.** They spend a member subscription and already
  require an explicit opt-in. Free protocol, sign-out, lifecycle, and daemon
  behavior remain required.
- **All upstream behavior.** The gates cover Blitz seams, contracts, package
  completeness, and representative daemon flows. They do not reimplement
  Lody's complete test suite.
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
| Native dependencies / architectures | The locked graph includes platform builds for `@lydell/node-pty`, while `better-sqlite3` 13 carries its prebuilds. Run target-stage `npm ci` and the import/help smoke under both release platforms. Add a compiler only if a future locked dependency requires one. |
| Adapter repository size | Budget about 1-2 MiB and 1.3k files at this pin. Sync only tracked source, never histories or build output. Review the exact size and any accidental growth in the staged diff. |
| Stale CLI version | Operators may see `0.76.0` from a much newer source build. Always log/display upstream SHA plus `distSha256`; do not infer compatibility from semver. |
| Licenses | Bundled workspace and adapter code makes the root notice set part of the distributed package. Copy it into `dist`, pin it byte-for-byte, and review adapter license/stamp changes in every sync. |
| First field migration | Legacy npm boxes have no stamp and remain usable. A cloud VM can be moved through the request-gated box-config v1 updater; it polls, replaces the container, and reports the installed ref (`packages/control-plane/core/box-config.ts:21-29`, `packages/control-plane/core/box-config.ts:126-180`). A microVM cannot update in place, so it keeps the old npm daemon until recreation. `docs/BOX-IMAGE.md` records this current split. |
| Immutable R2 storage growth | Release-keyed objects accumulate. Apply a lifecycle policy only after the maximum rollback/field-update window, and never delete the release currently reported by canary or any pending box update. |

### Follow-ups

The snapshots now exclude `dist/` and `node_modules/`. A later review can
consider excluding CI configuration, examples, tests, fixtures, docs, and
duplicate lockfiles. Keep those paths until that separate content review.

## Migration sequence

Each PR can ship on its own. PR A builds the reviewed artifact, so the pair
check is required. The shipping image and migration pieces remain separate.

### PR A: prove the pair in CI (landed)

- Landed: `packages/webapp/test/lody-daemon-harness.ts`,
  `packages/webapp/test/lody-post-signin-turn.test.ts`,
  `.github/workflows/ci.yml`, and add the initial shared
  `scripts/lody-build-package.mjs`.
- `LODY_BUNDLE`/`LODY_CLAUDE_BINARY` overrides and an artifact-producing daemon
  build run in the required `lody-daemon` job.
- The builder overlays the five reviewed trees landed in PR B. It does not
  change the shipping image or delete any npm patch yet.
- Evidence: all non-paid real-daemon suites run with a bundle. The built tarball
  and stamp are retained for inspection.

### PR B: make adapter inputs reviewed (landed)

- Landed: `vendor/lody-adapters/<five trees>` plus five stamps,
  `scripts/lody-sync-adapters.mjs`,
  `packages/webapp/test/lody-adapters-drift.test.mjs`, and root package scripts.
- The shared builder uses this reviewed overlay. Assert
  Kimi remains an excluded gitlink.
- Landed footprint: 1,269 upstream entries plus five stamps. The sync/drift
  code replaced the temporary scratch-fetch procedure.

### PR C: ship the source-built daemon (landed)

- Landed across `packages/box/Dockerfile`, `vendor/lody/UPSTREAM.md`,
  `vendor/lody/BLITZ-PATCHES.md`, CLI `message-processor.ts`, source/baseline
  tests, s6 comments, harness comments, and the build/stamp/dist-manifest tests.
- Added the Corepack/frozen builder, package install, notice, stamp, target smoke,
  ACP queue source seam, and focused behavior test. The follow-up fix pass made
  the target smoke boot the enabled image and made canary run it before publish.
- Deleted the npm daemon install item, all five compiled-patch files and Docker
  steps, and the harness patch list and loop. Platform and Code Collab retain
  regression coverage; builtin MCP and session sandbox use reviewed opt-in
  source/configuration seams.
- Kept the required CI pair job and reused its builder in image smoke. The pair
  job executes seams 19-21 from its preserved build scratch tree.
- The review follow-up added the lockfile-derived production shrinkwrap, target
  `npm ci`, the short runtime manifest, and deterministic single-copy stamp.
- It also removed the harness's automatic builder and the dead install test.

### PR D: expose and compare the pair (medium, about 300-450 lines)

- Add `packages/schema/fixtures/lody-build/`. Touch the bridge, gateway, Go
  tests, schema, harness endpoints, and Vite declarations. Add platform UI and
  guest/browser conformance tests.
- Add immutable stamp serving on `/lody/build`, the build-time upstream SHA,
  legacy tolerance, once-only structured skew log, and non-blocking update hint.
- Add the contract row to `CLAUDE.md`. Do not change `/lody/platform` bytes.

### PR E: automate upstream-to-canary (medium, about 350-500 lines)

- Add `scripts/lody-merge.mjs`, `scripts/lody-pin.mjs`, the machine-readable
  seam/input manifests and tests, and root `lody:merge` scripts.
- Consume the existing Lody-aware release identity from
  `.github/workflows/canary.yml`. Input coverage landed in the source-daemon
  review. #204 already added the immutable R2 image job and versioned routes.
  It also added publisher JSON mode and exact pin handoff. Add release BuildKit
  caching.
- Touch `.github/workflows/release.yml`, `docs/LODY-MERGE.md`,
  `docs/BOX-IMAGE.md`, `CLAUDE.md`, and `vendor/lody/UPSTREAM.md` for the final
  automated shape.
- Delete manual adapter/baseline mechanics now emitted by the command. Preserve
  the “never merge unattended” rule; the npm-selection and compiled-patch audit
  procedures were already removed from the rewritten runbook.

## What is simpler afterwards

The operating model is simpler because no step rewrites a compiled daemon.
The build tooling is larger, not smaller.

- **Independent Lody core pins: 2 -> 1.** Remove one npm daemon pin; retain one
  upstream revision mirrored by a checked squash trailer. The inherited five
  adapter gitlink SHAs and lockfile are supply-chain inputs, not a second daemon
  selection.
- **Compiled-bundle patch scripts: 5 -> 0.** Remove all five scripts and Docker
  invocations. Remove the duplicate harness path after source coverage lands.
- **Brittle compiled-artifact guards: 7 -> 0.** Remove one published-bundle
  SHA-256 guard, three hard-coded npm-version guards, and three compiled-anchor
  occurrence guards. Replace them with one source anchor plus behavior,
  provenance, package-set, and image smoke tests.
- **Runbook sections devoted to selecting/patching npm: 2 -> 0.** Delete current
  §§3 and 5. Current §§1 and 2 also become one command rather than two manual
  procedures.
- **Manual canary image operations after a current image-input change: already
  5 -> 0 in #204.** The separate build, feature edit, R2 publish, source pin
  edit, and follow-up pin merge are gone. Lody inputs are already part of the
  release identity. A reviewed merge starts or reuses its bake.
- **Runtime daemon paths changed: 0.** The s6 service, watchdog, bridge, tests,
  shell PATH, and webapp harness keep their installed paths.
