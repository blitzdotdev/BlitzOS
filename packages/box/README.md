# BlitzOS box

One OCI image is one complete agent workspace: key-only SSH, a ttyd + tmux
terminal, the ACP session actor, dufs WebDAV, and Docker-in-Docker. The state
volume keeps host keys, broker client state, agent HOME, the actor journal, and
box credentials. `/workspace` is a caller-owned bind mount.

## Install

Linux needs Docker. On a fresh Mac, install and start the free, open-source
[Colima](https://github.com/abiosoft/colima) runtime first:

```sh
brew install colima docker
colima start
```

Choose the workspace and an existing public key. Never mount a private key.
Replace the digest placeholder with the immutable digest from the release
notes, then run:

```sh
docker volume create blitz-box-state
docker run -d \
  --name blitz-box \
  --restart unless-stopped \
  --privileged \
  -e BLITZ_UID="$(id -u)" \
  -e BLITZ_GID="$(id -g)" \
  -v blitz-box-state:/var/lib/blitz \
  -v "$PWD:/workspace" \
  -v "$HOME/.ssh/id_ed25519.pub:/run/blitz/authorized_key:ro" \
  -p 127.0.0.1:2222:22 \
  ghcr.io/blitzdotdev/blitz-box@sha256:<IMAGE_DIGEST>
```

`--privileged` enables the inner Docker daemon. Without it, the other four
surfaces still start and dockerd reports a clean skip.

The box works without BlitzOS accounts or a control plane. Sign in to an agent
once over SSH with `claude login` or `codex login`; HOME persists on the state
volume. To attach a control plane, add this non-secret setting to the same run
command:

```sh
-e BLITZ_CP_ORIGIN=https://blitzos.com
```

On first enrollment, follow the verification URI and user code shown by:

```sh
docker logs -f blitz-box
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

After the fingerprints match, save the scanned key and open the three
loopback-only tunnels:

```sh
ssh-keyscan -p 2222 127.0.0.1 2>/dev/null > "$HOME/.ssh/blitz-box-known_hosts"
ssh -p 2222 \
  -o UserKnownHostsFile="$HOME/.ssh/blitz-box-known_hosts" \
  -N \
  -L 7443:127.0.0.1:7443 \
  -L 7444:127.0.0.1:7444 \
  -L 7445:127.0.0.1:7445 \
  blitz@127.0.0.1
```

The terminal is then at `http://127.0.0.1:7443`, ACP at
`ws://127.0.0.1:7444`, workspace files at
`http://127.0.0.1:7445/workspace/`, and agent HOME files at
`http://127.0.0.1:7445/home/`.

Limitation: dufs 0.46.0 has no stock Origin allowlist; concurrent file-sidebar saves are last-write-wins.

## Stop and upgrade

Stopping never deletes state or contacts a control plane:

```sh
docker stop blitz-box
```

For an upgrade, pull the new digest, remove only the stopped container, and
repeat the install command with that digest. Keep `blitz-box-state`:

```sh
docker pull ghcr.io/blitzdotdev/blitz-box@sha256:<NEW_IMAGE_DIGEST>
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
docker build -f packages/box/Dockerfile -t blitz-box:local .
packages/box/test/smoke.sh
```

Design record: `TODO.md`.
