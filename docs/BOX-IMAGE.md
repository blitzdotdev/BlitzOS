# The box image: build, publish, and ship it to workspaces

Every workspace VM runs one OCI image — the box — containing SSH, the
terminal, the ACP chat actor, the files/preview gateway, and Docker-in-Docker
([packages/box](../packages/box/README.md)). At boot, the VM's bootstrap
fetches the image named by the three `BOX_IMAGE_*` vars in
`packages/control-plane/wrangler.toml`. This page covers building the image,
the three ways to serve it, and how upgrades behave.

Part of the [self-host guide](SELF-HOST.md) (step 9).

## Choose a mode

| Mode | `BOX_IMAGE_REF` | `BOX_IMAGE_TAG` | `BOX_IMAGE_SHA256` | Choose when |
|---|---|---|---|---|
| **A — registry** (recommended) | immutable image reference, e.g. `ghcr.io/<owner>/blitz-box@sha256:<digest>` | `""` | `""` | You can publish the image publicly. Simplest, multi-arch, no R2 plumbing. |
| **B — single R2 archive** | `<your-worker-origin>/box-image` | the tag inside the archive | SHA-256 of the gzipped archive | The image must stay out of a registry and fits one reliable upload. |
| **C — multipart R2 archive** | `<your-worker-origin>/box-image/manifest.json` | the manifest's `imageTag` | the concatenated-archive digest (equals `totalSha256`) | Same as B, but the archive is too large for one upload; parts keep each object small. |

In modes B and C the archive lives in your `blitz-box-images` R2 bucket and is
served by your own Worker. **Both image routes are intentionally public** — the
VM bootstrap fetches them with no credential, so anyone with your Worker URL
can download the archive. The same is true of mode A: the bootstrap runs
`docker pull` with no registry login, so **the registry image must be publicly
pullable**. Treat the box image as public in every mode.

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

## Modes B and C: host the archive in R2

Build the image (see below), then publish it with the packaging script:

```sh
node packages/control-plane/scripts/publish-box-image.mjs --image blitz-box:local
```

The script runs `docker save`, gzips the archive, splits it into parts,
computes the per-part and total SHA-256 digests, writes the `manifest.json`,
uploads everything to the `blitz-box-images` bucket with `wrangler r2 object
put`, and prints the exact `BOX_IMAGE_*` values to set. Copy them into
`wrangler.toml` and redeploy. Add `--dry-run` to build and verify the release
without uploading; `--help`-style details (`--archive`, `--out`, `--bucket`,
`--app-url`, `--part-size-mb`) are in the script's usage text.

What lands in R2 (mode C):

- `box-image/manifest.json` —
  `{"parts":[{"name":"part-000","sha256":"<64 hex>"}, …],"totalSha256":"<64 hex>","imageTag":"blitz-box:<tag>"}`
- `box-image/<part-name>` for every part.

Mode B is the degenerate case: one gzipped archive at R2 key `box-image`, no
manifest. The manifest shape is a cross-runtime contract — the fixture corpus
in `packages/schema/fixtures/box-image-manifest/` is its source of truth; do
not hand-edit one side.

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

Run the image you built (same shape as the install command in the
[box README](../packages/box/README.md), pointed at the local tag):

```sh
docker volume create blitz-box-state
docker run -d \
  --name blitz-box \
  --restart unless-stopped \
  --privileged \
  --env-file env.defaults \
  -e BLITZ_UID="$(id -u)" \
  -e BLITZ_GID="$(id -g)" \
  --mount type=volume,source=blitz-box-state,target=/var/lib/blitz \
  --mount type=bind,source="$PWD",target=/workspace \
  --mount type=bind,source="$HOME/.ssh/id_ed25519.pub",target=/run/blitz/authorized_key,readonly \
  -p 127.0.0.1:2222:22 \
  blitz-box:local
```

## Smoke test

`packages/box/test/smoke.sh` exercises the whole surface: s6 service graph,
key-only SSH, ttyd/tmux, ACP, files, ports, previews, DinD, and the
unprivileged degradation path.

```sh
# Test a specific image:
IMAGE=blitz-box:local packages/box/test/smoke.sh

# With IMAGE unset the script tests blitz-box:local when that tag already
# exists locally; otherwise it builds a throwaway blitz-box:smoke first:
packages/box/test/smoke.sh
```

After `docker build -t blitz-box:local`, a plain `packages/box/test/smoke.sh`
therefore tests that image without a redundant second build.

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
