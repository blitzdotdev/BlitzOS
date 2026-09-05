# THIN-BASE: fewer parts in the layers that need a restart

Status: draft for the owner's review, 2026-09-05. Not merged. Companion to
`plans/THIN-IMAGE.md`, which put the fast-moving parts of a box into a payload
that applies in place. This plan shrinks what is left: the parts that still
need a container replacement or a new VM to change.

## 0. Decisions already made

Recorded from the discussion on 2026-09-05.

- The box stays a privileged container on a VM. Docker is what freezes the
  environment, the hostname and the service graph at start. The answer is to
  move flags and services into files the payload owns, not to remove Docker.
- The host keeps a rescue path. The host sshd stays on port 2222 and the box
  keeps port 22. The relocation block in the bootstrap stays.
- The payload channel stays. Nothing here makes an update kill a session.
- The rebase choices of PR #217 stand: the daemon version is
  `<upstream12>+dist.<dist12>`, the publisher refuses a daemon archive from a
  different upstream pin, and the lab suffixes `+lab.<serial>`.

## 1. Why

The split in THIN-IMAGE assumed the base changes a few times a year. The
history of the first three weeks says otherwise. Each change below was a
container replacement for every box that received it.

| Part | Commits, 2026-08-12 to 2026-09-05 |
|---|---|
| `packages/box/Dockerfile` | 34 |
| `core/bootstrap.ts` (host scripts) | 30 |
| s6 service set (`user/contents.d`) | 14 |
| `env.defaults` | 12 |
| `blitz-cred` | 11 |

The rule this plan applies: a part is base only when a restart cannot avoid
its change, or when it is the recovery floor that repairs a bad payload.
Everything else moves to the payload or leaves.

## 2. The moves

### D. The payload owns the service set

Today the set of s6 services, their types and their dependencies are base.
s6-overlay compiles `/etc/s6-overlay/s6-rc.d` into a database when the
container starts. A payload can replace a `run` script. It cannot add,
remove or redefine a service. Fourteen of the base rebuilds above were only
that.

Proven on 2026-09-05 inside the real image (`blitz-box:smoke`, s6-overlay
3.2.1.0), with tools already in `/command`:

1. `s6-rc-compile /run/s6/db-next <tree> <s6-overlay sources>` compiled a
   tree with a new longrun `hello` in the `user` bundle.
2. `s6-rc-update /run/s6/db-next` brought `hello` up at once. sshd and the
   gateway kept their pids.
3. A compile without `hello` and a second update took it down and removed
   its scandir. sshd and the gateway kept their pids.
4. A tree that gave `machine-stats` a new dependency was applied live.
   `machine-stats` restarted because its definition changed. Nothing else did.

Design:

- The payload ships the whole `s6-rc.d` tree under
  `/opt/blitz/payload/<version>/services/`. `/etc/s6-overlay/s6-rc.d` in the
  image is a symlink to `/opt/blitz/payload/current/services`, so first boot
  compiles whatever payload is current.
- On a switch, the updater compiles the new tree to `/run/s6/db-<version>`
  before it flips `current`. A failed compile is `verify-failed` and changes
  nothing. After the flip it runs `s6-rc-update`. Rollback is an update back
  to the previous database, which the updater keeps.
- s6 restarts a service whose definition changed. The manifest's restart map
  stays for the other case: a binary or libexec file changed under a service
  whose `run` did not.
- The floor guard: the updater refuses a payload whose tree lacks
  `init-state`, `cgroups`, `payload` and the `user` bundle membership of
  `payload`. A payload cannot remove the updater's own service.
- The manifest becomes `box-payload v2`: it lists the `services/**` files
  and sets `minUpdater: 2`. A v1 updater reports `unsupported` and keeps the
  running payload until its base ships.

Deletes: the "service set is base" rule, 45 topology entries from
`BOX_IMAGE_INPUTS`, and the base image as the delivery for a new service.

### C. The box environment leaves `env.defaults`

Today `env.defaults` is 156 lines. Six describe the box. The rest document the
control plane, the microVM host and the webapp. The Dockerfile copies the whole
file, `blitz-box-run` injects it as the container environment, and it is a base
input. Editing a webapp default rebuilds the box image. The one box value that
changes, `BLITZ_LODY_SESSIONS`, is applied by a Docker build argument and a
`sed`, which is why the smoke builds two images.

After:

- `BLITZ_STATE_DIR`, `S6_KEEP_ENV` and the default uid and gid are Dockerfile
  `ENV` lines. The host passes uid and gid with `-e` as it does today.
- Feature flags come from the control plane. The phone-home response carries
  `features`, and the host writes `/var/lib/blitz/features` before the
  container starts. `box-config` carries the same object, and the updater
  rewrites the file and restarts the services that read it when it changes.
  Turning Lody on is a deploy var, like the payload pin.
- `env.defaults` keeps its role as documentation for the other programs. The
  box stops reading it.

Deletes: the build argument and its `sed`, the second smoke build, the
`docker run --rm --entrypoint cat` env refresh in `blitz-box-run`, and
`env.defaults` from the base inputs.

Contracts: `phone-home v1` and `box config v1` gain an optional `features`
object. Both need fixtures on both sides before either side changes.

### A. The host tooling leaves user-data

Today `core/bootstrap.ts` is a 906-line TypeScript string that emits about
600 lines of bash and inline Python as cloud-init user-data: apt watchdog,
zram, volume mount, shutdown hook, sshd relocation, the manifest loader,
`blitz-box-run`, phone-home, the host updater and its timer, and the register
poke. It is a template because a Worker cannot read files at runtime. Its
bytes are pinned by tests as a contract. Hetzner caps its size.

After:

- The host scripts are plain files in `packages/box/host/`: `blitz-zram`,
  `blitz-volume-shutdown`, `blitz-box-run`, `blitz-box-update`, their
  systemd units, and one `install.sh`. The box image carries them under
  `/opt/blitz/host/`.
- User-data shrinks to per-VM values and one short first-boot script: apt
  with its watchdog, docker, the volume mount, the image load, then
  `docker create` and `docker cp` to take `/opt/blitz/host/` out of the
  image, then `install.sh`. The manifest loader stays in user-data because it
  runs before any image exists.
- The host updater runs `install.sh` again after every image replacement, so
  host tooling versions with the base image on its own.
- The golden bake runs the same first-boot script in a bake mode with no
  phone-home, then snapshots. A golden host and a stock host are the same
  host. The bake's own "lever 2" unit list moves into `install.sh`.

Deletes: most of `bootstrap.ts`, the emitted-bytes contract tests in favor of
file tests, the user-data size pressure, and the bake's duplicated levers.

### B. First boot starts the container with its credential

Today the container starts first because the box makes its own SSH host key.
The host then waits up to 180 s for that key, phones home, receives the
credential, writes it and the origin onto the volume, and pokes
`blitz-cred register` through `docker exec` because the box's own register
step already ran and skipped. A box whose credential arrives late runs signed
out for the life of the boot.

After: the host generates the ed25519 host key into `/var/lib/blitz/ssh`
with the ownership `blitz-init-state` expects, phones home, writes the
credential and the origin, then starts the container. The `register` oneshot
finds the origin and enrolls. The poke and the 180 s wait go away. The
readiness check after start stays.

Contract: `phone-home v1` does not change. Check that the corpus allows the
ecdsa and rsa keys to be absent when only ed25519 exists at that point.

### E. Small moves

- `sshd_config`, `gitconfig`, `tmux.conf` and `blitz-npm.sh` become payload
  files. The payload already owns the ForceCommand target and every root-run
  script, so this changes no trust boundary.
- `xz-utils` is only used to unpack the s6 tarballs at build time. Install it
  in the artifacts stage only.
- Keep one editor. Decide whether `python3` stays as a promised agent tool;
  no box code uses it.
- Pin `gh` as a static release binary. It is the one unpinned build input.
- Replace the zram script and unit with one `systemd-zram-generator` config
  as part of A.
- Fold the `machine-stats` loop into the updater tick. One service and its
  topology go away.
- Later, not in this plan: `blitz-cred` leaves the base once the updater can
  refresh its own bearer in node. That removes the Go stage from the base.

## 3. Phases

Two pull requests. The first ships one base image; the second ships new host
scripts and a golden rebake.

### Phase 1: the box

D, C and the small moves in E. One base image ships the v2 updater, the
symlinked service tree, the `ENV` lines and the smaller package set. The
payload publishes as v2 with `minUpdater: 2`.

Gates:

- Contract tests for `box-payload v2`, and for `features` in `box config` and
  `phone-home`, with fixtures on both sides.
- The smoke, now one image build, asserts the symlinked tree compiles at boot
  and the floor guard refuses a tree without `payload`.
- Guest tests run the real updater over the compile, update and rollback
  path against a stand-in `s6-rc-compile` and `s6-rc-update`.
- Lab: E3 again, plus E17 "a payload adds a service and nothing else
  restarts" and E18 "a payload removes a service", on the thinlab.

### Phase 2: the host

A and B. New VMs only; existing hosts keep their scripts until recreated.

Gates:

- `bash -n` and shellcheck over `packages/box/host/`.
- The existing host updater test runs the file instead of the emitted string.
- One fresh VM boot per provider, and one golden rebake with the probe.

## 4. Not in this plan

- The VM as the box. The container stays.
- Removing the host sshd. The rescue path stays.
- Signing payload manifests. That is its own decision.
- The broker and credential roaming.

## 5. Open questions for the owner

- Does `python3` stay as a promised agent tool?
- Is the passwordless-sudo host user with the member's key intended?
