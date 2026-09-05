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

The payload now owns every file under `rootfs/etc/s6-overlay/s6-rc.d/`.
That ownership includes types, dependencies, launchers, and bundle membership.
The payload also owns its launcher directory.
The updater binary remains base-owned.

The repository declares `user` and `user2` as bundles.
It declares `user2/contents.d` as an empty payload directory.
The top bundle names `user2`.
The compiler rejects a bundle without `contents.d`.

The image replaces `/etc/s6-overlay/s6-rc.d` with one absolute symlink.
The symlink targets `/opt/blitz/payload/current/rootfs/etc/s6-overlay/s6-rc.d`.
First boot compiles the baked payload tree.
Container recreation compiles the restored baked tree.

Updater state lives in `/opt/blitz/payload/state`.
Downloaded releases live in `/opt/blitz/payload/versions/<version>`.
Both are in the container image layer, not the state volume.
A recreation loses them together, starts from baked, and downloads the pin on
the first tick. A restart keeps both and resumes pending recovery.

Protocol 2 adds the optional `directories` manifest field.
The parser defaults an omitted field to an empty list.
The publisher always writes the field and sets `minUpdater: 2`.
The content version hashes the directory list.
The publisher maps source executable bits to `0755` and all other files to `0644`.
Protocol 2 keeps every archive path below `rootfs/`.
Protocol 1 therefore parses published manifests and reports `unsupported`.
Protocol 2 boxes refuse protocol 1 releases.
The control plane must not pin protocol 1 for rollback on a protocol 2 image.
The payload publisher now emits only protocol 2 releases.

Restart keys no longer use a fixed vocabulary.
Each key names a longrun in the manifest's own tree.
The updater verifies the extracted type before activation.
The restart map handles changed binaries and libexec files.
`s6-rc-update` handles changed service definitions.
The updater removes changed definitions from map-driven restarts.

The updater freezes four service definitions during live updates.
They are `cgroups`, `init-state`, `register`, and `payload`.
Their files must match the running tree by content and mode.
Their payload-owned executable bodies may still change.
The guard also requires both bundles and the payload bundle membership.
The payload launcher must execute the base-owned updater.

The updater compiles into `/run/s6/.blitz-db-staging-<pid>-<nonce>`.
It renames a successful compile into place on the same filesystem.
Initialization protects the live database before cleaning that anchored namespace.
It requires exactly one s6-overlay sources directory.
A compiler failure reports `verify-failed` and preserves current links.
After the link flip, the updater runs `s6-rc-update` with a timeout.
It then applies remaining map-driven restarts and checks health.
The committed state records current and previous database paths.
The updater resolves the live compiled pointer instead of persisting it.

Rollback trusts only databases completed by the staging rename.
It compiles the previous tree when no completed database is available.
It restores both links and updates s6 to that database.
It re-converges the `user` bundle before filtered map restarts and health checks.
A rollback restart set contains only longruns from the previous tree.
A separate flag preserves every forward cause for Lody daemon health.
The flag applies only when the previous tree contains the Lody longrun.
A failed rollback keeps its pending record until every recovery step succeeds.
A failed recovery reports `start-failed` and retries on the next tick.
An unreachable control plane leaves that result queued.
A failed forward `s6-rc-update` uses the same rollback path.
Garbage collection keeps the committed current and previous databases.
It also resolves and keeps `/run/s6-rc/compiled` before deleting any database.
It keeps both actual current link targets and both pending release targets.

`blitz-payload tick` performs one complete poll and exits.
The supervised launcher and CLI ticks share one kernel-backed `flock` on
`/run/blitz-payload.lock`.
The CLI refuses a live lock with exit 75 and tells the operator to stop the
payload service or wait.
An active CLI tick can delay payload-service startup for its full remaining
runtime. Each launcher attempt waits at most 300 seconds. While the lock stays
held, s6 restarts the launcher and retries.
The CLI also exits nonzero when pending rollback recovery fails.
The supervised command keeps its fail-open polling loop.
Operators and smoke tests use the same tick path.

A container restart compiles the tree selected by `current`.
Every pending rollback phase remains resumable after either link or the live
database was already restored. No instance stamp is needed because state,
downloaded releases, and current links reset together on recreation.

The smoke runs three live updates against an in-container origin.
E17 adds `hello` while sshd and gateway keep their pids.
E18 removes `hello` while those pids remain stable.
E19 removes the payload service and receives `verify-failed`.
E19 leaves both current links and both pids unchanged.

This move removes every s6 topology entry from `BOX_IMAGE_INPUTS`.
Adding or redefining a service no longer rebuilds the base image.

### C. The box environment leaves `env.defaults`

The image now declares `BLITZ_STATE_DIR`, `S6_KEEP_ENV`, `BLITZ_UID`, and
`BLITZ_GID` with Docker `ENV`. `BLITZ_CP_ORIGIN` stays unset, so
`blitz-init-state` acts only when an operator deliberately supplies it. The
repository `env.defaults` retains the broker, control-plane, microVM-host, and
webapp documentation but has no box section and is no longer a base-image
input.

Deployed phase-1 hosts are the compatibility boundary. Their existing
`blitz-box-run` still extracts `/etc/blitz/env.defaults` from every candidate
image and passes it to Docker with `--env-file`; deleting that path would stop
every such host from starting a new container. `microvm-init` also sources that
file when an OCI image becomes a rootfs. The Dockerfile therefore writes the
same four assignments to the file with one `printf`. The file and Docker `ENV`
must stay equal. This move deliberately does not edit either reader.

Box config v1 has an optional `features` object, currently
`{lodySessions: boolean}`. The Worker always emits it and treats only
`BOX_LODY_SESSIONS=1` as enabled. The in-box updater owns the wire-to-env name
table and materializes every known flag in
`/opt/blitz/payload/state/features` after every successful config fetch,
including a held or unpinned response. An absent member is the all-false
default for older control planes. Writes use a temporary file, mode 0644,
root ownership, and rename.

When the bytes change, the updater reads the `run` file of every longrun in the
current payload service tree and restarts, in name order, exactly those whose
source mentions the literal `/opt/blitz/payload/state/features`. It writes
`features.applied` only after every restart succeeds. A kill after the feature
rename or a failed restart therefore retries on the next identical config.
The Lody daemon uses its controlled TERM/PID/KILL restart. A feature flip is a
deliberate operator action and is never deferred for an active session. The
four Lody launchers wait for the file, match one exact record with `grep`, and
idle with `sleep infinity` while the flag is off. They never evaluate the file
as shell.

Phone-home is unchanged. The deployed microVM guest parser accepts only its
exact three- or five-field response, while both box-config consumers already
ignore unknown top-level members. Features therefore travel through
box-config only.

Before the updater has fetched one valid box-config in its process lifetime,
a missing origin or bearer retries after 15 seconds. After first contact it
uses the ordinary interval. HTTP failures always use the ordinary interval,
including a pre-contact 401, so failed-report traffic cannot burst. The first
supervised tick starts five seconds after boot.

The Docker Lody build argument and sed are gone. Canary deploys
`BOX_LODY_SESSIONS=1` beside its payload pin; production leaves it unset until
it pins a payload. The smoke builds one image, seeds the feature file in the
container layer before boot, keeps E17-E19 on `lodySessions: true`, and flips it
off and on in E20 while proving only the four readers restart.

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

`sshd_config`, `gitconfig`, `tmux.conf` and `blitz-npm.sh` are payload files.
The image replaces all four installed paths with absolute symlinks through
`/opt/blitz/payload/current`, using the same ordinary-file installation path
as payload binaries and libexec files. The restart map derives the `sshd`
dependency from its run file's `/etc/blitz/sshd_config` argument, so it needs
no override. Restarting the listener does not drop an established connection:
OpenSSH's per-connection child outlives the supervised listener. The smoke
holds a live SSH session across `s6-svc -r /run/service/sshd` and proves it
continues afterward.

`xz-utils` is installed only in the artifacts stage, where tar uses it to
unpack the s6-overlay `.tar.xz` files. Neither the package nor `xz` reaches the
final stage. `nano` is removed. `vim` stays and provides both `vim` and the
`vi` fallback used by Git and other tools. `python3` also stays: the owner has
not answered whether it is a promised agent tool, so this slice does not make
that product decision.

GitHub CLI is the verified static Linux release binary at version `2.100.0`
for both amd64 and arm64. Each architecture has its own Docker `ADD` checksum,
taken from the official release asset
`https://github.com/cli/cli/releases/download/v2.100.0/gh_2.100.0_checksums.txt`.
The apt keyring, apt repository and unversioned package installation are gone.

The updater now sends machine stats once after every successful authenticated
tick, on the same five-minute cadence as payload polling. It measures
`BLITZ_STATE_DIR` with `fs.statfsSync`: `used = blocks - bfree`, then
`ceil(used * 100 / (used + bavail))`. A statfs error, an out-of-range result,
HTTP refusal or unreachable endpoint logs one skipped report and never fails
the tick. The old `blitz-machine-stats` executable, longrun, dependency and
bundle membership are deleted; `s6-rc-update` removes that service on existing
boxes. The fixture corpus remains the control-plane accept rule, and the guest
producer test now drives the real `blitz-payload tick` against a local origin.

The zram replacement remains deferred to A, where host tooling moves as a
unit. `blitz-cred` also remains base-owned as planned; moving bearer refresh
into the dependency-free updater is a later change.

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
