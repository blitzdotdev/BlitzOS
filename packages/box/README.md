# BlitzOS box

One OCI image provides one agent workspace.
s6 starts key-only SSH, ttyd, dufs, the gateway, Docker, and control-plane helpers.
It also initializes persistent state and the optional cgroup boundary.
Control-plane helpers register broker keys, refresh the bearer, sync rules, and deposit agent logins.
Other longruns provide Claude Remote Control and payload updates.
The optional Lody set contains the daemon, Unix bridge, project registrar, and watchdog.
ttyd uses tmux for named, persistent terminal, Claude, and Codex sessions.
dufs backs `/workspace/` for file browsing, uploads, and Lody attachments.
The gateway exposes that WebDAV surface at `/workspace/`.
It also discovers ports, proxies HTTP and WebSocket previews, and relays terminal WebSockets.
Five exact `/lody/*` routes reach Lody through its Unix-socket bridge.
cloudflared connects hosted browser traffic after provisioning supplies its tokens.
Docker-in-Docker starts only when the container is privileged.

The payload owns the complete s6 service tree and its launchers.
The base image owns the payload updater and `blitz-cred`.
`/var/lib/blitz` keeps SSH keys, agent HOME, Docker data, Lody data, tokens, and credentials.
`/workspace` is a caller-owned bind mount.

The image includes Git, Node 22, Claude Code, Codex, and Python 3.
It pins the static `gh` binary at version 2.100.0.
`vim` provides both `vim` and `vi`.
`nano` is not installed.

## Install

Linux needs Docker.
On a fresh Mac, install and start the free, open-source Colima runtime:

```sh
brew install colima docker
colima start --cpu 4 --memory 8
unset DOCKER_HOST
```

Colima defaults to two CPUs and 2 GiB of memory.
Give this box at least four CPUs and 8 GiB.
These resources cover the image build, inner Docker daemon, and agent work.

A `v*` release publishes registry images.
Its release notes contain each immutable digest.
Before the first release, build `blitz-box:local` with the final section.

Choose a workspace and an existing public key.
Never mount a private key.
Replace the digest placeholder, then run:

```sh
docker volume create blitz-box-state
docker run -d \
  --name blitz-box \
  --restart unless-stopped \
  --privileged \
  -e BLITZ_UID="$(id -u)" \
  -e BLITZ_GID="$(id -g)" \
  --mount type=volume,source=blitz-box-state,target=/var/lib/blitz \
  --mount type=bind,source="$PWD",target=/workspace \
  --mount type=bind,source="$HOME/.ssh/id_ed25519.pub",target=/run/blitz/authorized_key,readonly \
  -p 127.0.0.1:2222:22 \
  ghcr.io/<your-github-owner>/blitz-box@sha256:<IMAGE_DIGEST>
```

The long `--mount` form fails when a bind source is missing.
Short `-v` can silently create a directory instead.

`--privileged` enables inner Docker and permits cgroup setup when controllers are delegated.
Without it, `dockerd` logs a clean skip.
The other web endpoints still start.

The box works without a BlitzOS account or control plane.
Sign in over SSH with `claude login` or `codex login --device-auth`.
The state volume keeps both agents' HOME data.

A control-plane connection needs an origin and a box credential.
`BLITZ_CP_ORIGIN` writes only the origin during state initialization:

```sh
-e BLITZ_CP_ORIGIN=<your-control-plane-origin>
```

Provisioned hosts write `/var/lib/blitz/box-credential.json` after phone-home.
Do not put credentials in Docker environment variables or arguments.

### Managed host layout

Cloud provisioning installs `/usr/local/bin/blitz-box-run` on the VM host.
That script runs `blitz-box` as a privileged container.
It bind-mounts `/var/lib/blitz`, the authorized key, and `/var/lib/blitz/workspace`.
It passes `BLITZ_UID=1000` and `BLITZ_GID=1000`.
It publishes `0.0.0.0:22` to container port `22`.
It does not publish ports `7443` or `7445`.
cloudflared carries hosted browser traffic to those loopback services.
The bootstrap moves the host SSH listener to port `2222`.

### Container environment

The Dockerfile sets four box configuration defaults:

```text
BLITZ_STATE_DIR=/var/lib/blitz
S6_KEEP_ENV=1
BLITZ_UID=1000
BLITZ_GID=1000
```

The direct run command overrides both identity defaults.
`/etc/blitz/env.defaults` contains only a compatibility comment.
Phase-one host scripts extract that file and pass it with `--env-file`.
Nothing inside the box reads the repository's `env.defaults`.
`BLITZ_CP_ORIGIN` has no image default.

Set the control-plane variable `BOX_LODY_SESSIONS=1` to enable Lody.
Only the exact value `1` enables it.
The control plane sends `features.lodySessions` through box-config.
The payload updater writes the result to `/opt/blitz/payload/state/features`.
The enabled record is exactly `BLITZ_LODY_SESSIONS=1`.
The four Lody longruns read that record without evaluating it as shell code.
The flag is not a Docker build argument or box environment setting.
A fresh standalone container leaves the Lody services waiting for the feature file.
A feature change restarts all four Lody readers immediately.
It does not wait for active Lody turns.

## Verify and connect

Read the expected SSH host-key fingerprint from the container.
Compare it with the fingerprint returned on the published port:

```sh
docker exec blitz-box ssh-keygen -lf /var/lib/blitz/ssh/ssh_host_ed25519_key.pub
ssh-keyscan -p 2222 127.0.0.1 2>/dev/null | ssh-keygen -lf -
```

After they match, save the scanned key.
Then open the two loopback-only tunnels:

```sh
ssh-keyscan -p 2222 127.0.0.1 2>/dev/null > "$HOME/.ssh/blitz-box-known_hosts"
ssh -p 2222 \
  -o UserKnownHostsFile="$HOME/.ssh/blitz-box-known_hosts" \
  -N \
  -L 7443:127.0.0.1:7443 \
  -L 7445:127.0.0.1:7445 \
  blitz@127.0.0.1
```

Open the terminal at `http://127.0.0.1:7443`.
Open workspace files at `http://127.0.0.1:7445/workspace/`.
The files surface supports browsing, uploads, WebDAV clients, and Lody attachments.
It never publishes the agent HOME or its OAuth credentials.
Port discovery and previews use the same `7445` origin.

### Terminal URL contract

ttyd accepts ordered, repeated `arg` query parameters:

```text
http://127.0.0.1:7443/?arg=<terminal|claude|codex>&arg=<session-key>[&arg=ro]
```

The WebSocket form uses the same query on `ws://127.0.0.1:7443/ws`.
It uses the WebSocket subprotocol `tty`.
The session key has 1 through 128 characters.
It accepts `A-Z`, `a-z`, `0-9`, `_`, and `-`.
The launcher names tmux sessions `term-<key>`, `claude-<key>`, or `codex-<key>`.
The optional `ro` argument attaches read-only to an existing session.
A URL without query parameters opens one plain login shell.

Hosted clients can reach the same terminal WebSocket at `/terminal/ws` on the gateway.

### Ports and preview URL contract

Poll the files origin for listening TCP ports:

```text
GET http://127.0.0.1:7445/ports
=> {"ports":[{"port":3000,"process":"node"}]}
```

The gateway hides cloudflared listeners and reserved box ports.
Reserved ports are `22`, `7443` through `7446`, `17445`, and `17789`.
Use the same origin for preview URLs:

```text
http://127.0.0.1:7445/preview/<port>/
http://127.0.0.1:7445/preview/<port>/<path>?<query>
```

The gateway strips `/preview/<port>` from the upstream path.
It forwards HTTP and WebSocket traffic to `127.0.0.1:<port>`.
Hosted ingress uses the resolver's files origin instead of `http://127.0.0.1:7445`.

### Lody session surface

An enabled Lody surface uses five exact gateway paths:

```text
GET  /lody/sync      WebSocket CRDT data
POST /lody/rpc       machine RPC
POST /lody/control   session control
POST /lody/project   local-project control
GET  /lody/platform  local identity and workspace data
```

The hosted gateway applies the same ticket authentication used by other `7445` routes.
An ordinary workspace viewer receives `403` on every Lody path.
A shared ticket may reach these five paths and no other box surface.
The bridge enforces each shared session's read and write scope.
The gateway proxies Lody through `/var/lib/blitz/lody-bridge.sock`.
The browser never reaches the daemon directly.
Port `17789` is the daemon's reserved single-instance lease.

`lody-projects` polls for Git repositories directly under `/workspace`.
It registers each repository as a local Lody project.
`lody-watchdog` restarts a hung daemon.
It can kill the heaviest Lody session during sustained memory pressure.

## Stop and upgrade

Stopping the direct Docker installation keeps its named state volume:

```sh
docker stop blitz-box
```

### Payload channel

The payload channel changes a running container in place.
It updates payload-owned commands, service helpers, the gateway, agent rules, and the Lody daemon.
It also updates `/etc/blitz/sshd_config`, `/etc/gitconfig`, `/etc/profile.d/blitz-npm.sh`, and `/etc/tmux.conf`.
It can add, remove, or redefine s6 services.
It rejects live changes to four recovery service definitions.
Those services are `cgroups`, `init-state`, `register`, and `payload`.
An update that restarts Lody waits while the daemon reports active turns.
The default wait cap is four hours.
At that cap, it forces the restart and may disconnect those turns.

The supervised updater starts its first tick five seconds after boot.
It normally polls box-config every five minutes.
Each successful authenticated tick sends one report to `POST /workspaces/self/machine-stats`.
It reports the used percentage for the filesystem containing `BLITZ_STATE_DIR`.
A stats failure logs one skipped report and does not fail the tick.

`/usr/local/libexec/blitz-payload tick` performs one poll and exits.
It shares `/run/blitz-payload.lock` with the supervised updater.
The command exits `75` while the supervised updater holds that lock.
Stop the service before an operator tick, then start it again:

```sh
docker exec blitz-box /command/s6-svc -d /run/service/payload
docker exec blitz-box /usr/local/libexec/blitz-payload tick
docker exec blitz-box /command/s6-svc -u /run/service/payload
```

The command also exits nonzero when pending rollback recovery fails.
Updater state lives in `/opt/blitz/payload/state`.
Its log is `/opt/blitz/payload/state/log`.
Downloaded payload releases live in `/opt/blitz/payload/versions/<version>`.
These paths live in the container layer, not the state volume.

A container restart keeps the selected payload, updater state, and downloaded releases.
A container recreation loses those items and starts from its baked payload.
A connected recreation downloads the current pin on its first tick.
The mounted `/var/lib/blitz` state and `/workspace` data remain intact.

### Base image channel

A base image is still required for base layers, `blitz-cred`, or the base-owned updater.
Replacing the base image recreates the container and kills every process inside it.

On a provisioned cloud VM, run `blitz box update` inside the box.
The command asks the control plane for a base replacement.
The host updater polls that request about every five minutes.
It pulls or loads the target before removing the current container.
It starts the target with `/usr/local/bin/blitz-box-run`.
It restores the previous image when the target fails to start.

For a direct Docker installation, pull the new digest first.
Then remove only the stopped container:

```sh
docker pull ghcr.io/<your-github-owner>/blitz-box@sha256:<NEW_IMAGE_DIGEST>
docker rm blitz-box
```

Repeat the install command with the new digest.
Reuse `blitz-box-state`.

Give each additional box a distinct container, volume, workspace, and SSH host port.
Use different local tunnel ports when two boxes are connected.

## Build and smoke test

The build context must be the repository root.
Build the daemon archive before calculating the baked payload version.
Use that exact archive when publishing the matching payload.

The following sequence builds one box image and smoke-tests that image:

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
IMAGE=blitz-box:local packages/box/test/smoke.sh
```

`IMAGE=<tag>` tests that image without building another image.
With `IMAGE` unset, the smoke builds one image named `blitz-box:smoke`.
That default prevents stale images from hiding service-tree changes.

The smoke runs live payload cases E17 through E20.
E17 adds `hello` while keeping the sshd and gateway processes.
E18 removes `hello` while keeping those processes.
E19 rejects a release that removes the payload recovery service.
It keeps both current links and both unrelated processes unchanged.
E20 disables and enables Lody through box-config features.
It restarts only the four Lody feature readers.

The smoke also checks key-only SSH, terminal persistence, files, previews, Docker, and unprivileged fallback.
It verifies the `gh` pin, `vim`, and the absence of `nano`.

Run the local image with the [Install](#install) command.
Use `blitz-box:local` instead of the registry reference.
See [docs/BOX-IMAGE.md](../../docs/BOX-IMAGE.md) for registry and R2 publishing.
