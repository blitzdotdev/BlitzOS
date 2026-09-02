# The box image: build, publish, and ship it to workspaces

Every workspace VM runs one OCI image — the box — containing SSH, the
terminal, the files/preview gateway, and Docker-in-Docker
([packages/box](../packages/box/README.md)). At boot, the VM's bootstrap
fetches the image named by the three `BOX_IMAGE_*` vars in
`packages/control-plane/wrangler.toml`. This page covers building the image,
the two ways to serve it, and how upgrades behave.

Part of the [self-host guide](SELF-HOST.md) (step 9).

## Choose a mode

| Mode | `BOX_IMAGE_REF` | `BOX_IMAGE_TAG` | `BOX_IMAGE_SHA256` | Choose when |
|---|---|---|---|---|
| **A — registry** (recommended) | immutable image reference, e.g. `ghcr.io/<owner>/blitz-box@sha256:<digest>` | `""` | `""` | You can publish the image publicly. Simplest, multi-arch, no R2 plumbing. |
| **B — R2 archive** | `<your-worker-origin>/box-image/manifest.json` | the manifest's `imageTag` | the concatenated-archive digest (equals `totalSha256`) | The image must stay out of a registry. The archive is split into parts, so its size does not matter. |

In mode B the archive lives in your `blitz-box-images` R2 bucket and is served
by your own Worker. **Both image routes are intentionally public** — the
VM bootstrap fetches them with no credential, so anyone with your Worker URL
can download the archive. The same is true of mode A: the bootstrap runs
`docker pull` with no registry login, so **the registry image must be publicly
pullable**. Treat the box image as public in every mode.

## Which mode each hosted deployment uses

| Deployment | Mode | Why |
|---|---|---|
| **client prod** | A — GHCR | `release.yml` builds and pushes the image on a `v*` tag, then pins the digest it just built. |
| **canary** | B — R2 archive | Nothing but `release.yml` may push to GHCR, and that workflow also deploys client prod. Canary needs to rebake without touching a paying client. |

This split is deliberate, and it is the answer to "the canary box image is
stale, rebuild it". **Pushing to `ghcr.io/blitzdotdev/blitz-box` requires
`write:packages`, and the only credential that holds it is the
`GITHUB_TOKEN` inside `release.yml`, which runs only on a `v*` tag push.**
A workspace credential cannot push: measured 2026-08-30, `GH_PAT` reads the
repository (HTTP 200) and pulls the image manifest (HTTP 200) but is refused
at `POST /v2/blitzdotdev/blitz-box/blobs/uploads/` (HTTP 403), and the Blitz
GitHub App token has no package access at all. That is the boundary working,
not a fault to route around.

Cutting a `v*` tag to refresh the canary image is the wrong instrument: it
ships the platform to client prod, and that decision belongs to a human. So
canary carries its own image in its own account's R2 bucket, and rebaking it
touches nothing outside `minjunesv0`.

### Rebaking the canary image

Run this whenever `git diff --stat <deployed-sha>..HEAD -- packages/box
packages/broker` is non-empty — box and broker changes reach new workspaces
only through the image.

1. Build from a clean worktree at `origin/main` (the build context is the
   repository root):

   ```sh
   git -C /workspace/BlitzOS worktree add -b box-image /workspace/BlitzOS-box-image origin/main
   cd /workspace/BlitzOS-box-image
   docker build --platform linux/amd64 -f packages/box/Dockerfile -t blitz-box:<sha> .
   ```

2. **Turn the Lody session daemon on in the image.** `env.defaults` tracks
   `BLITZ_LODY_SESSIONS=0` on purpose — it is the default for every
   deployment, including a self-hosted fork that should stay dark — but the
   canary image is expected to ship it ON, and `canary.yml` says so beside
   `VITE_BLITZ_LODY_SESSIONS`: "half one is BLITZ_LODY_SESSIONS inside the
   image above, which is already baked on".

   ```sh
   sed -i 's/^BLITZ_LODY_SESSIONS=0/BLITZ_LODY_SESSIONS=1/' env.defaults
   ```

   This is a working-tree edit that must NOT be committed, exactly like the
   `wrangler.toml` below. Baking without it produces an image whose
   `lody-daemon` service execs `sleep infinity`: the box is healthy, the
   tunnel is up, terminals work, and every Lody pane is blank with no
   "New session" — the rail that cannot list a session `canary.yml` warns
   about. Measured 2026-09-02: the image before this step carried
   `BLITZ_LODY_SESSIONS=1` only as an uncommitted edit in the build worktree,
   so the first clean rebake from `origin/main` silently turned Lody off for
   every new box.

3. Give the worktree a **canary-scoped** `packages/control-plane/wrangler.toml`.
   The publish script always passes `--config` to wrangler, and the copy in the
   main checkout is **client prod's** (`account_id = "d25a778b…"`,
   `APP_URL = "https://blitzos.com"`). Publishing with that config uploads the
   canary image into the client's bucket. Start from `wrangler.toml.example`
   and set `account_id` to the canary account and `APP_URL` to the canary
   origin. The file is gitignored, so it never lands in a commit.

4. Publish to R2 with the canary token (`CF_CLAUDE_TOKEN_STAGING`; never print
   it). Add `--dry-run` first to see the values without uploading:

   ```sh
   CLOUDFLARE_API_TOKEN="$CF_CLAUDE_TOKEN_STAGING" \
   CLOUDFLARE_ACCOUNT_ID=53a144fad4e15ca51c32da9b9fe25d4a \
     node packages/control-plane/scripts/publish-box-image.mjs --image blitz-box:<sha>
   ```

5. Pin the three values it prints in `.github/workflows/canary.yml` as
   `BLITZ_DEPLOY_VAR_BOX_IMAGE_REF`, `BLITZ_DEPLOY_VAR_BOX_IMAGE_TAG` and
   `BLITZ_DEPLOY_VAR_BOX_IMAGE_SHA256`, beside the `HETZNER_SERVER_IMAGES`
   line that already works this way. A deploy var becomes `wrangler deploy
   --var NAME:VALUE`, which overrides that one key and leaves every other var
   from `CANARY_WRANGLER_TOML` in place — so the pin lives in a reviewable
   commit rather than inside a secret nobody can read back. None of the three
   is a secret: the archive is public by design, because the VM bootstrap
   fetches it with no credential.

6. Merge to `main`. Canary redeploys and **new** boxes boot the new image.
   Existing boxes never upgrade in place.

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
without uploading. The remaining options (`--archive`, `--out`, `--bucket`,
`--app-url`, `--part-size-mb`) are listed by `--help`.

What lands in R2:

- `box-image/manifest.json` —
  `{"parts":[{"name":"part-000","sha256":"<64 hex>"}, …],"totalSha256":"<64 hex>","imageTag":"blitz-box:<tag>"}`
- `box-image/<part-name>` for every part.

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

## Build locally

The build context is the repository root (the image compiles
`packages/broker` into `blitz-cred`):

```sh
docker build --platform linux/amd64 -f packages/box/Dockerfile -t blitz-box:local .
```

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
unprivileged degradation path.

```sh
# Builds a throwaway blitz-box:smoke from this tree, then tests it:
packages/box/test/smoke.sh

# Tests an image you already have, and never builds:
IMAGE=blitz-box:local packages/box/test/smoke.sh
```

Building is the default on purpose. This is the only gate that runs the s6
service graph, so a run that silently adopted an existing tag could pass an
edit to `rootfs/` or an s6 unit against an image that predates it. `IMAGE=`
skips the build, and then the freshness of that tag is yours to guarantee.

## Upgrade and rollback

Point the `BOX_IMAGE_*` vars at the new image and redeploy the control plane.
The vars only affect **newly created** VMs: a workspace keeps the image it
booted with for its whole life. To move existing workspaces to a new image,
destroy and recreate them.

Rollback is the same operation in reverse — restore the previous values and
redeploy. VMs created during the bad window keep the bad image until recycled.

This boot-time pinning is why the control plane gates some per-workspace
behavior on the VM's creation time (the `BOX_IMAGE_*_SINCE_MS` constants in
`core/webapp-tickets.ts`): a fleet always contains VMs on older images, and
the control plane must speak to each VM at the level its image understands.
For a fresh fork all your images postdate those cutoffs; the constants only
matter to fleets with history.
