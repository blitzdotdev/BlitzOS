# BlitzOS box

One OCI image is one complete agent workspace: key-only SSH, a ttyd + tmux
terminal, WebDAV plus preview routing, and Docker-in-Docker. The state volume
keeps host keys, broker client state, agent HOME, and box credentials.
`/workspace` is a caller-owned bind mount.

## Install

Linux needs Docker. On a fresh Mac, install and start the free, open-source
[Colima](https://github.com/abiosoft/colima) runtime first:

```sh
brew install colima docker
colima start --cpu 4 --memory 8
unset DOCKER_HOST
```

Colima's default VM (2 CPUs, 2 GiB memory) is too small for the box's inner
Docker daemon and agent harnesses — and for building the image; give it at
least 4 CPUs and 8 GiB.

The registry reference below works once a `v*` release has published images
(registry mode in [docs/BOX-IMAGE.md](../../docs/BOX-IMAGE.md)); the release
notes carry the immutable digest. With no release yet, build the image
locally as described in [Build and smoke test](#build-and-smoke-test) and put
`blitz-box:local` in place of the registry reference.

Choose the workspace and an existing public key. Never mount a private key.
Replace the digest placeholder with the immutable digest from the release
notes, then run:

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
  ghcr.io/<your-github-owner>/blitz-box@sha256:<IMAGE_DIGEST>
```

The long `--mount` form fails when a bind-mount source is missing; short `-v`
can silently create a directory instead.

`--privileged` enables the inner Docker daemon. Without it, the other webApp
endpoints still start and dockerd reports a clean skip.

The box works without BlitzOS accounts or a control plane. Sign in to an agent
once over SSH with `claude login` or `codex login --device-auth`; HOME
persists on the state volume. To attach a control plane, add this non-secret
setting to the same run command:

```sh
-e BLITZ_CP_ORIGIN=<your-control-plane-origin>
```

Hosted provisioning can instead pre-write the origin and box credential on
the state volume. Credentials never belong in Docker environment variables or
arguments.

## Verify and connect

Read the expected SSH host-key fingerprint from the container, then compare it
with the fingerprint returned on the published port:

```sh
docker exec blitz-box ssh-keygen -lf /var/lib/blitz/ssh/ssh_host_ed25519_key.pub
ssh-keyscan -p 2222 127.0.0.1 2>/dev/null | ssh-keygen -lf -
```

After the fingerprints match, save the scanned key and open the two
loopback-only tunnels:

```sh
ssh-keyscan -p 2222 127.0.0.1 2>/dev/null > "$HOME/.ssh/blitz-box-known_hosts"
ssh -p 2222 \
  -o UserKnownHostsFile="$HOME/.ssh/blitz-box-known_hosts" \
  -N \
  -L 7443:127.0.0.1:7443 \
  -L 7445:127.0.0.1:7445 \
  blitz@127.0.0.1
```

The terminal is then at `http://127.0.0.1:7443` and workspace files at
`http://127.0.0.1:7445/workspace/`. The agent HOME is deliberately not
published: it holds the agent's OAuth credentials. Port discovery and preview
share the files origin, so they need no additional SSH forward or ingress
route.

### Terminal URL contract

ttyd accepts the v2 webApp's ordered, repeated `arg` query parameters:

```text
http://127.0.0.1:7443/?arg=<terminal|claude|codex>&arg=<session-key>[&arg=ro]
```

The direct WebSocket equivalent is the same query on
`ws://127.0.0.1:7443/ws`, with WebSocket subprotocol `tty`. `session-key` must
be 1–128 characters from `A-Z`, `a-z`, `0-9`, `_`, or `-`. The launcher maps
the types to persistent tmux sessions named `term-<session-key>`,
`claude-<session-key>`, and `codex-<session-key>`. `ro` attaches a tmux client
read-only. Omitting the query entirely opens one non-tmux login shell for
older webApp clients.

### Ports and preview URL contract

Poll the existing files HTTP origin:

```text
GET http://127.0.0.1:7445/ports
=> {"ports":[{"port":3000,"process":"node"}]}
```

The list includes listening TCP ports and excludes SSH, ttyd, the public
gateway, its private dufs upstream, the reserved port 7444, and 17789 (the Lody
daemon's single-instance host lease). Use the same origin for preview URLs:

```text
http://127.0.0.1:7445/preview/<port>/
http://127.0.0.1:7445/preview/<port>/<path>?<query>
```

The gateway strips `/preview/<port>` and forwards HTTP and WebSocket traffic
to `localhost:<port>`. Under hosted ingress, replace
`http://127.0.0.1:7445` with the resolver's files origin; TLS,
authentication, and WebSocket handling remain those of that existing route.

Limitation: dufs 0.46.0 has no stock Origin allowlist; concurrent file-sidebar saves are last-write-wins.

### Lody session surface

Five exact paths on the same 7445 origin, added by phases 1 and 2 of
`plans/LODY-SESSIONS.md`:

```text
GET  http://127.0.0.1:7445/lody/sync      (websocket)  CRDT data plane
POST http://127.0.0.1:7445/lody/rpc                    machine RPC
POST http://127.0.0.1:7445/lody/control                session control
POST http://127.0.0.1:7445/lody/project                local-project control
GET  http://127.0.0.1:7445/lody/platform               the daemon's own identity
```

All five are ticket-authenticated like every other 7445 surface, and all five
are refused to a workspace viewer with 403 — unless the ticket carries a session
SHARE claim, which is the phase-6 exception (`plans/LODY-SHARING.md`). A shared
ticket may reach these five paths and nothing else on the box: not dufs, not a
preview, not the terminal. They are declared in
`packages/schema/src/webapp-surface.ts` and
`packages/control-plane/core/webapp-surface.ts`, and drift-tested on both sides.

What a share may SAY on those paths is the bridge's decision, not the gateway's:
the gateway forwards the verified claim on `X-Blitz-Lody-Share` (stripping any
inbound copy) and the bridge enforces the per-room ACL, scopes machine RPC and
worktree reads to the granted sessions, refuses `/lody/control` outright, and
serves `/lody/platform` narrowed so a grantee never learns the box's other
sessions. The decision table is a fixture corpus,
`packages/schema/fixtures/lody-share-claim/`.

Neither reaches the daemon directly. The gateway proxies them over a unix socket
to `blitz-lody-bridge`, which re-serves two of the Lody daemon's own unix
sockets: `/sync` onto its Loro data plane and `/rpc` onto its control socket's
`/machine-rpc`. The daemon binds no TCP port the browser can reach — only the
17789 host lease, which is reserved rather than proxied.

A third service, `lody-projects`, registers every git repository directly under
`/workspace` with the daemon as a Lody local project, so a worktree session has
something to cut a worktree off (`plans/LODY-SESSIONS.md` §6.4). It polls rather
than running once, because the template-repo cloner keeps arriving for up to ten
minutes after boot and a member may clone by hand on any day after that. It talks
only to the daemon's own control socket and opens no port.

All three s6 services (`lody-daemon`, `lody-bridge`, `lody-projects`) are dark
unless `BLITZ_LODY_SESSIONS=1`; the default in `env.defaults` is `0`.

Scope fence: the box keeps deliberately NO analytics, metering, or usage store.
Usage and eval data comes from the native harness transcripts in the agent HOME
(`~/.claude/projects/…`, `~/.codex/sessions/…`).

## Stop and upgrade

Stopping never deletes state or contacts a control plane:

```sh
docker stop blitz-box
```

For an upgrade, pull the new digest, remove only the stopped container, and
repeat the install command with that digest. Keep `blitz-box-state`:

```sh
docker pull ghcr.io/<your-github-owner>/blitz-box@sha256:<NEW_IMAGE_DIGEST>
docker rm blitz-box
```

For multiple boxes, give each one a distinct container name, state volume,
workspace bind mount, and SSH host port, for example `blitz-box-2`,
`blitz-box-state-2`, and `127.0.0.1:2223:22`. Use different local tunnel ports
when both instances are connected at once.

## Build and smoke test

The build context is the repository root because the image compiles
`packages/broker` into `blitz-cred`:

```sh
payload_version=$(node packages/control-plane/scripts/plan-box-payload.mjs --print-version)
docker build --platform linux/amd64 \
  --build-arg "BLITZ_PAYLOAD_VERSION=$payload_version" \
  -f packages/box/Dockerfile -t blitz-box:local .
packages/box/test/smoke.sh
```

With `IMAGE` unset, `smoke.sh` builds its own image tagged `blitz-box:smoke`
from this tree — it is the only gate that runs the s6 service graph, so it
never adopts a tag that might predate your edits. `IMAGE=<tag>` smoke-tests
that image instead and skips the build.

To run the local image, use the [Install](#install) `docker run` command with
`blitz-box:local` in place of the registry reference.

Publishing the image for workspace VMs — registry or R2 archive — is covered
in [docs/BOX-IMAGE.md](../../docs/BOX-IMAGE.md).

Design record: `TODO.md`.
