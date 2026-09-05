# The box image: build, publish, and ship it to workspaces

Every workspace VM starts from one OCI image — the box — containing SSH,
Docker-in-Docker, the service graph, and the in-place payload updater
([packages/box](../packages/box/README.md)). The image carries a baked payload
for first boot; the control plane then pins the current scripts, Blitz binaries,
service implementations, and Lody daemon as a separately published payload.
This page covers both artifacts, the ways to serve the image, and how upgrades
behave.

Part of the [self-host guide](SELF-HOST.md) (step 9).

## Choose a mode

| Mode | `BOX_IMAGE_REF` | `BOX_IMAGE_TAG` | `BOX_IMAGE_SHA256` | Choose when |
|---|---|---|---|---|
| **A — registry** (recommended) | immutable image reference, e.g. `ghcr.io/<owner>/blitz-box@sha256:<digest>` | `""` | `""` | You can publish the image publicly. Simplest, multi-arch, no R2 plumbing. |
| **B — R2 archive** | `<your-worker-origin>/<key-prefix>/manifest.json` — canary uses `box-image/<releaseId>`; a manual publish defaults to the legacy `box-image` | the manifest's `imageTag` | the concatenated-archive digest (equals `totalSha256`) | The image must stay out of a registry. A prefix per release lets old and new archives coexist, and the archive is split into parts so its size does not matter. |

In mode B the archive lives in your `blitz-box-images` R2 bucket and is served
by your own Worker. **Every box-image route is intentionally public** — the
VM bootstrap fetches them with no credential, so anyone with your Worker URL
can download the archive. The same is true of mode A: the bootstrap runs
`docker pull` with no registry login, so **the registry image must be publicly
pullable**. Treat the box image as public in every mode.

## Which mode each hosted deployment uses

| Deployment | Mode | Why |
|---|---|---|
| **client prod** | A — GHCR | `release.yml` builds and pushes the image on a `v*` tag, then pins the digest it just built. |
| **canary** | B — R2 archive | The `image` job in `canary.yml` automatically publishes changed base-image inputs under a versioned R2 prefix, then the deploy pins that release. |

The image pin has three deployment vars. `BOX_IMAGE_REF` is either the
immutable registry digest or the public R2 manifest URL. `BOX_IMAGE_TAG` and
`BOX_IMAGE_SHA256` are required only for an R2 archive: they name the Docker
tag loaded from the archive and authenticate the reassembled bytes.

The in-place payload has two inseparable vars:

- `BOX_PAYLOAD_REF` is the public, versioned
  `box-payload/<version>/manifest.json` URL.
- `BOX_PAYLOAD_VERSION` is the manifest's content hash and the desired version
  each non-held machine should run.

Set both from one validated release or set `BOX_PAYLOAD_REF = ""` to disable
payload delivery. Never mix the ref from one release with another version.
Canary publishes this payload today. Client prod remains image-only until the
owner chooses an architecture contract for its amd64/arm64 fleet; see the
[production plan](DEPLOY-RUNBOOK.md#how-client-prod-is-deployed).

This split is deliberate. **Pushing to `ghcr.io/blitzdotdev/blitz-box` requires
`write:packages`, and the only credential that holds it is the
`GITHUB_TOKEN` inside `release.yml`, which runs only on a `v*` tag push.**
A workspace credential cannot push: measured 2026-08-30, `GH_PAT` reads the
repository (HTTP 200) and pulls the image manifest (HTTP 200) but is refused
at `POST /v2/blitzdotdev/blitz-box/blobs/uploads/` (HTTP 403), and the Blitz
GitHub App token has no package access at all. That is the boundary working,
not a fault to route around.

Cutting a `v*` tag to refresh the canary image is the wrong instrument: it
ships the platform to client prod, and that decision belongs to a human. So
canary carries its own image in its own account's R2 bucket, without touching
client prod.

### Automatic canary image publish

On every push to `main`, `canary.yml` publishes or reuses both releases under
the `canary` environment:

1. It checks out the merged tree, sets up Node, runs `npm ci`, writes the
   canary `wrangler.toml` from
   `CANARY_WRANGLER_TOML`, and reads `APP_URL` from that config.
2. The `image` job builds `daemon.tar.gz` from the Dockerfile's `daemon` stage
   and builds the amd64 gateway binary with the same Go version as the
   Dockerfile. `blitz-cred` is base-owned so a bad payload cannot disable the
   updater's bearer acquisition. It runs
   `plan-box-payload.mjs --print-version --daemon <archive> --binaries <dir>`;
   the resulting hash includes that exact daemon archive digest.
3. It computes a base release id from the Git object ids named by
   `scripts/lib/box-image-inputs.mjs`. The full
   64-character SHA-256 becomes `<releaseId>`, the image tag is
   `blitz-box:<releaseId>`, and the R2 prefix is `box-image/<releaseId>`.
4. It requests
   `<APP_URL>/box-image/<releaseId>/manifest.json`. A valid manifest with the
   expected image tag means that exact release is already published, so the
   job reuses its `totalSha256`. A 404 means it must publish. An invalid
   manifest, a mismatched tag, any other HTTP status, or a network error fails
   the job instead of pretending the release is absent.
5. For an absent base release, it runs
   `docker build --platform linux/amd64 --build-arg BLITZ_LODY_SESSIONS=1 --build-arg BLITZ_PAYLOAD_VERSION=<planned-payload-version> -f packages/box/Dockerfile -t <imageTag> .`.
   The daemon archive was built before the version was planned, so this baked
   stamp is the same daemon-inclusive version the payload publisher will use.
   The other build argument turns Lody on for canary while the committed
   `env.defaults` stays off for self-hosters; the Dockerfile rejects any
   non-empty value other than `0` or `1`.
6. It runs
   `node packages/control-plane/scripts/publish-box-image.mjs --image <imageTag> --prefix <prefix> --app-url <APP_URL> --json publish.json`.
   The publisher uploads every part before `manifest.json`, so a release is
   not visible until all its parts exist.
7. Only after the image job succeeds, the `payload` job rebuilds the daemon
   archive and the gateway binary, plans with `--daemon`, and refuses to continue
   unless its version equals the one used by the image job. It probes
   `<APP_URL>/box-payload/<version>/manifest.json`; a valid manifest for that
   version is reused, 404 is published with the same `--daemon <archive>`, and
   malformed content or any other response fails the deploy. The publisher
   uploads `payload.tar.gz` and `daemon.tar.gz` before `manifest.json`.
8. The payload job exposes `ref` and `version`. The deploy pins those alongside
   the image outputs and verifies that `/version` reports the merged commit and
   expected box-image tag.

The base release id deliberately excludes payload-owned files, the gateway
binary, and the daemon; it includes the base-owned credential broker sources.
It also includes `env.defaults`: environment is fixed when the container is
created, so changing that file requires an image rather than an in-place
payload. A payload-only merge therefore reuses the current image rather than
rebuilding it. Its baked stamp names only the bytes in the baked payload and
is unaffected by the later canary-only `env.defaults` mutation; it may name the payload current
when that base was built; that is informational boot state, not the rollout
pin. A fresh machine starts there and the updater converges it to
`BOX_PAYLOAD_VERSION`. When a base input changes, the new image is stamped with
the daemon-inclusive payload version published by the same run. The Dockerfile,
the updater, and the s6 service set/topology remain image inputs.

**Lody release identity.** The release key covers every repository source in a
Dockerfile `COPY`. That includes `vendor/lody`, reviewed adapter snapshots, and
all shared Lody build scripts. A pure Lody-input change therefore selects a new
release ID. The key uses Git object IDs instead of walking the large trees.
`box-image-key.test.mjs` parses the Dockerfile and rejects any uncovered source.
Follow `docs/LODY-MERGE.md` for the upstream procedure.

### Lody daemon package and provenance

The `lody-build` Docker stage runs the same
`scripts/lody-build-package.mjs --source vendor/lody` path used by the pair
gate. It overlays the five reviewed adapter snapshots, performs the frozen pnpm
install and CLI build, verifies the package manifest, and emits a tarball plus
`BUILD.json`. It also derives `npm-shrinkwrap.json` from the CLI production
graph in `pnpm-lock.yaml`. Exact registry URLs and integrities pin every runtime
package. A BuildKit cache mount retains the pnpm 10.20 store by Node line.
The architecture-neutral build stage does not key that cache by target platform.
The lockfile and build inputs still invalidate the build layer. Files outside
the Lody inputs, including `packages/webapp`, do not.
Adapter snapshots exclude generated `dist/` and `node_modules/` trees. The
`lody-adapters-drift.test.mjs` gate checks that every tracked Lody builder input
survives the ordered Dockerfile ignore rules.

The target-platform vendors stage extracts that tarball at the established
global prefix. It runs `npm ci` at the package root, where npm enforces the
shrinkwrap and checks every integrity. Lifecycle scripts stay enabled for
native dependencies. The package remains
`/opt/blitz/npm/lib/node_modules/lody`, and s6 still executes
`/opt/blitz/npm/bin/lody start`. Its only stamp is `dist/BUILD.json` inside that
package. Plan PR D will serve that file over `/lody/build`.

The `canary` environment's `CLOUDFLARE_API_TOKEN` must be able to write the
`blitz-box-images` bucket. A token that can deploy the Worker but cannot write
that R2 bucket makes either publishing job fail.

A canary release occupies these keys:

- `box-image/<releaseId>/manifest.json`
- `box-image/<releaseId>/part-NNN` for every archive part
- `box-payload/<version>/manifest.json`
- `box-payload/<version>/payload.tar.gz`
- `box-payload/<version>/daemon.tar.gz`

Old and new releases must coexist. Existing boxes and older deployed Worker
versions retain the full `BOX_IMAGE_REF` they received, so publishing a new
release must not change or remove the bytes at an older URL. The legacy
`box-image/manifest.json` and `box-image/part-NNN` routes remain served for
boxes already in the field; the automatic job never writes that slot.

A human does nothing to publish or pin the canary image now: merging to `main`
is sufficient. For an intentional manual R2 slot, pass
`--prefix <key-prefix>` to `publish-box-image.mjs`; pass
`--prefix box-image` explicitly only when replacing the legacy unversioned
slot.

**Single-arch.** A `docker save` archive carries one architecture, so the
canary archive is amd64. That matches the canary catalog, which offers x86
Hetzner types only. Adding an arm type means revisiting this.

## Mode A: publish to a registry

Pushing a git tag `v*` runs `.github/workflows/release.yml`, which builds
`blitz-box` (and `blitz-broker`) for `linux/amd64` and `linux/arm64` and
pushes them to GHCR under your repository owner:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The workflow appends the immutable digests to the GitHub release notes. Then:

1. In the `blitz-box` package's settings on GitHub (Package settings →
   Danger zone → Change visibility), make it **public**. GHCR packages
   default to private on first push.
2. Set the vars:

   ```toml
   BOX_IMAGE_REF = "ghcr.io/<your-github-owner>/blitz-box@sha256:<digest-from-release-notes>"
   BOX_IMAGE_TAG = ""
   BOX_IMAGE_SHA256 = ""
   ```

3. `npm run deploy -w packages/control-plane`.

Pin by digest, not by tag: the VM pulls whatever the reference resolves to at
boot, and a digest is the only immutable reference.

### Automatic releases (tag → deploy)

`release.yml` finishes the release for you when two repository secrets exist:

- `PROD_WRANGLER_TOML` — the full contents of your deployment's
  `wrangler.toml`, in the comment-free generated form (the deploy cannot
  patch a TOML that holds comments).
- `CLOUDFLARE_API_TOKEN` — a token that can do what the local deploy does:
  Workers Scripts Edit, D1 Edit, and Workers R2 Storage Edit on the account.

With both set, every `v*` tag push builds the images and then deploys the
control plane with `BOX_IMAGE_REF` pinned to the digest it just pushed —
steps 2 and 3 above run in CI, and no manual release step remains. The CI
deploy is the same `npm run deploy` an operator runs: it applies D1
migrations and ships the worker code at the tag, so a tag is a full platform
release, not only an image swap. Worker secrets never touch CI — the deploy
only checks that they exist on the Worker.

Without the secrets the job skips with a notice, so forks and CI-only
checkouts are unaffected. The one manual step left is one-time: make the
`blitz-box` GHCR package public (step 1 above). The deploy job verifies the
digest is publicly pullable before deploying and fails otherwise — so on
your very first release, flip the visibility when that step fails, then
re-run the job. Nothing deploys an image workspaces cannot pull.

## Mode B: host the archive in R2

Build the image (see below), then publish it with the packaging script:

```sh
node packages/control-plane/scripts/publish-box-image.mjs --image blitz-box:local
```

The script runs `docker save`, gzips the archive, splits it into parts,
computes the per-part and total SHA-256 digests, writes the `manifest.json`,
uploads everything to the `blitz-box-images` bucket with `wrangler r2 object
put`, and prints the exact `BOX_IMAGE_*` values to set. Copy them into
`wrangler.toml` and redeploy. Add `--dry-run` to build and verify the release
without uploading. Use `--prefix <key-prefix>` for a named manual slot; it
defaults to the legacy `box-image` layout. The remaining options (`--archive`,
`--out`, `--bucket`, `--app-url`, `--part-size-mb`, `--json`) are listed by
`--help`.

What lands in R2 under the chosen prefix:

- `<key-prefix>/manifest.json` —
  `{"parts":[{"name":"part-000","sha256":"<64 hex>"}, …],"totalSha256":"<64 hex>","imageTag":"blitz-box:<tag>"}`
- `<key-prefix>/<part-name>` for every part.

A single-part archive is just a manifest with one part, so there is no
separate "small archive" mode to choose. The Worker still serves an
unsplit archive at `GET /box-image` for deployments configured that way
before the packaging script existed; nothing produces one now.

The manifest shape is a cross-runtime contract — the fixture corpus in
`packages/schema/fixtures/box-image-manifest/` is its source of truth; do not
hand-edit one side.

**Single-arch warning.** A `docker save` archive carries one architecture.
An amd64 archive boots amd64 machines only. Keep the archive's architecture
matched to the machine types you offer; if you need both architectures, use
mode A, whose release build is multi-arch.

**Open arm64 payload item.** The payload identity and publisher currently
derive from amd64 gateway bytes. Defining an architecture-qualified arm64
payload identity is intentionally out of scope for thin-image v1; do not point
arm64 boxes at the amd64 payload pin until that contract is designed.

## Build locally

Use Node 22 and Go 1.26.5. The daemon archive must exist before the payload
version is derived, and the exact same archive must go to the publisher. The
build context is the repository root:

```sh
release_dir=$(mktemp -d)
daemon_archive="$release_dir/daemon.tar.gz"

node packages/control-plane/scripts/build-box-daemon.mjs \
  --out "$daemon_archive"
payload_version=$(node packages/control-plane/scripts/plan-box-payload.mjs \
  --print-version --daemon "$daemon_archive")
docker build --platform linux/amd64 \
  --build-arg "BLITZ_PAYLOAD_VERSION=$payload_version" \
  -f packages/box/Dockerfile -t blitz-box:local .
node packages/control-plane/scripts/publish-box-payload.mjs \
  --daemon "$daemon_archive"
```

That order is load-bearing: build daemon, derive with `--daemon`, stamp the
image, then publish with the same `--daemon`. Planning without it derives a
different version. `publish-box-payload.mjs` stages and verifies
`payload.tar.gz`, uploads it and `daemon.tar.gz` under
`box-payload/<version>/`, then uploads `manifest.json` last. It uses the
`BOX_IMAGES` R2 binding and `APP_URL` in
`packages/control-plane/wrangler.toml`; `--dry-run --out <dir>` keeps the
verified artifacts locally instead. Run
`publish-box-image.mjs --image blitz-box:local` as described in mode B when the
image also needs publishing.

On macOS, install and start Colima first — and size it up. The defaults
(2 CPUs, 2 GiB memory) are too small for this build plus the inner Docker
daemon; give it at least 4 CPUs and 8 GiB:

```sh
brew install colima docker
colima start --cpu 4 --memory 8
unset DOCKER_HOST
```

Run the image you built with the `docker run` command in the box README's
[Install](../packages/box/README.md#install) section, substituting
`blitz-box:local` for the registry reference. That command is the one canonical
copy; it carries the `--privileged` and long-`--mount` reasoning with it.

## Smoke test

`packages/box/test/smoke.sh` exercises the whole surface: s6 service graph,
key-only SSH, ttyd/tmux, files, ports, previews, DinD, and the
unprivileged degradation path. It builds both the default-disabled image and
the same `BLITZ_LODY_SESSIONS=1` variant canary ships, then boots the enabled
variant. The Lody checks use a 180-second wall-clock deadline with bounded host
commands while waiting for the supervised daemon and bridge, probe bridge
health and `/lody/platform`, require the packaged `dist/BUILD.json`, inspect
the live daemon environment and cgroup, and require its
built-in-MCP-disable log. In CI the smoke also requires memory, pids, and CPU
delegation and proves that the `blitz` user can create and remove a child under
`lody-sessions` with `memory.max`, `pids.max`, and `cpu.max`. The shipping CLI
has no credential-free adapter, so real session limits and cleanup are instead
exercised by the vendor sandbox suite in the daemon pair gate.

```sh
# Builds a throwaway blitz-box:smoke from this tree, then tests it:
packages/box/test/smoke.sh

# Tests an already-built Lody-enabled image, and never builds:
IMAGE=blitz-box:local packages/box/test/smoke.sh
```

Building is the default on purpose. This is the only gate that runs the s6
service graph, so a run that silently adopted an existing tag could pass an
edit to `rootfs/` or an s6 unit against an image that predates it. `IMAGE=`
skips the build, requires that tag's baked default to enable Lody, and leaves
the freshness of that tag yours to guarantee. Canary runs this form with
`LODY_BOOT_ONLY=1` immediately after its enabled build and before publishing any
archive parts, exiting after the Lody and cgroup checks rather than repeating
the later terminal/files/preview checks already owned by PR CI.

## Upgrade and rollback

Point the `BOX_IMAGE_*` vars at the new image and redeploy the control plane.
New VMs use that pin immediately. An existing cloud VM moves only after an
owner or admin requests an update through the box-config v1 routes in
`packages/control-plane/core/box-config.ts`; the host updater emitted by
`packages/control-plane/core/bootstrap.ts` polls, replaces the container, and
reports the installed ref. MicroVMs have no in-place updater and keep their old
image until recreation.

`BOX_PAYLOAD_REF` and `BOX_PAYLOAD_VERSION` affect existing machines. Their
updaters poll box config, verify and apply the content-addressed release, and
report the running payload and daemon versions. An unacknowledged report is
kept in updater state and retried before the next poll does new work. To roll back, restore **both**
vars from the previous immutable payload release and redeploy. A lower version
is an ordinary target, so machines apply it on their next poll. Do not replace
objects under the current version; publish another content hash.

Hold one machine on its current payload with the session-authenticated,
workspace-admin route:

```http
PATCH /machines/<machine-id>
Content-Type: application/json

{"payloadHold":true}
```

A hold makes that machine's box config answer `payload: null`; it does not
change the deployment-wide pin or undo the version already running. Send
`{"payloadHold":false}` to resume, at which point the machine converges to the
current deployment pin.

Read fleet state from the authenticated `GET /workspaces/<workspace-id>`
response. Each `workspace.members[].machine` reports `id`, `payloadVersion`,
`daemonVersion`, `payloadOutcome`, and `payloadReportedAt`; the versions name
what is running after the attempt, while a failure's detail names its target.
A null version means
that machine has not reported since the payload channel shipped. Compare each
`payloadVersion` with `BOX_PAYLOAD_VERSION`, and inspect the outcome/time before
declaring a rollout complete.

Image rollback is the same operation in reverse: restore the previous
`BOX_IMAGE_*` values and redeploy. VMs created during the bad image window keep
that image until recycled, while their in-place payload can still be rolled
back independently.

This boot-time pinning is why the control plane gates some per-workspace
behavior on the VM's creation time (the `BOX_IMAGE_*_SINCE_MS` constants in
`core/webapp-tickets.ts`): a fleet always contains VMs on older images, and
the control plane must speak to each VM at the level its image understands.
For a fresh fork all your images postdate those cutoffs; the constants only
matter to fleets with history.
