# THIN-IMAGE: a box that updates in place, on the control plane's schedule

Status: implemented on branch `feat/thin-image-payload` (PR #217).
Owner of the schedule: the control plane. Owner of nothing: the box.

## 0. The rule

A box image is rebuilt when the base changes: OS packages, node, docker, s6,
base-owned binaries, or the updater itself. Everything else is a **payload**
the control plane publishes and every box applies in place, with bounded,
known interruption and automatic rollback when it does not come up.

Before this branch, the only update path replaced the container
(`core/bootstrap.ts` host updater, `blitz-box-run`), which killed every session,
terminal and agent on the box — an update is a reboot by another name. A
customer never reboots a box; we force it, and a forced reboot that lands in a
stalled box strands them (2026-09-04, `docs/MEMORY-BOUNDARY.md`). The agent
CLIs already update themselves in place under the uid-1000 npm prefix with zero
interruption; this generalises that to everything we ship.

## 1. What is base, what is payload

| Base (image only) | Payload (in place) |
|---|---|
| Debian + node 22 + docker static + s6-overlay; Docker `ENV` and the generated `/etc/blitz/env.defaults` compatibility file | every other script under `rootfs/usr/local/{bin,libexec}` plus four `/etc` files |
| the payload updater `blitz-payload`, `blitz-cred`, and their runtime dependencies | the full s6 source tree, except the frozen recovery floor |
| frozen `cgroups`, `init-state`, `register`, and `payload` service definitions | `blitz-box-gateway` (linux/amd64; arm64 later) |
| `/opt/blitz/npm` prefix with claude, codex, ws | the Lody **daemon bundle** (the `lody` package built from `vendor/lody`) |
| a baked copy of the current payload + daemon bundle (§3) | agent rules skeleton |

`claude`/`codex` keep self-updating as today; not part of this.

## 2. Artifacts and the contract

Two archives and one manifest per release are published by the control-plane
tooling and pinned by deploy vars. The Worker serves them under
`/box-payload/<version>/…`, like `/box-image/<releaseId>/…`
(`core/box-image-routes`).

### 2.1 `manifest.json` (contract: `box-payload v2`)

This abridged example shows the field shapes. The fixture corpus holds complete
valid releases.

```json
{
  "version": "20260904T2130Z-9f3c1a2b",
  "createdAt": 1788550000000,
  "minUpdater": 2,
  "files": [{ "path": "rootfs/usr/local/libexec/blitz-term", "sha256": "…", "mode": "0755" }],
  "directories": ["rootfs/etc/s6-overlay/s6-rc.d/user2/contents.d"],
  "archive": { "url": "…/box-payload/<version>/payload.tar.gz", "sha256": "…", "bytes": 1234 },
  "daemon": { "version": "f4b1ba259eb7+dist.3c1e9a7b5d20", "protocolVersion": 7, "url": "…/box-payload/<version>/daemon.tar.gz", "sha256": "…", "bytes": 1234 },
  "restart": { "gateway": ["rootfs/usr/local/bin/blitz-box-gateway"], "…": [] }
}
```

- `version` is the SHA-256 of a canonical encoding of the sorted
  `(path, sha256, mode)` records in `files`, the sorted directory paths, the
  daemon archive SHA-256 (or `none`), and the sorted `restart` map. It never
  includes Git history, `createdAt`, build scripts, or base-owned files.
- `files` lists every file in `payload.tar.gz` with its digest; the updater
  verifies each file after extraction, not just the archive.
- `directories` lists empty payload directories. The parser defaults an omitted
  field to an empty list, while the publisher always writes it.
- `daemon` is a separate archive so a script-only release does not re-download
  the daemon. Its `version` is the upstream commit plus the dist digest from
  the package's build stamp (`<upstream12>+dist.<dist12>`); two releases with
  the same daemon version share the object.
- `restart` maps payload-owned longruns to the payload paths they depend on.
  Each key must name a longrun in the manifest's service tree. The updater
  compiles and applies service changes before it handles remaining mapped
  restarts.
- `minUpdater`: an updater older than this reports `unsupported` and applies
  nothing; the control plane then knows an image update is required.
- Protocol 2 boxes refuse protocol 1 releases before downloading an archive.
  A rollback pin for these boxes must name a protocol 2 release.

Fixtures: `packages/schema/fixtures/box-payload/` — valid manifests, each
malformed field, a `minUpdater` too high, and invalid service-tree restart keys.
Producer conformance runs in `control-plane/test`. Consumer conformance runs
the real updater in `box/guest-tests/test`. Types live in
`packages/schema/src/box-payload.ts`; `wire-drift.test.ts` pins the wire copy.

### 2.2 `payload.tar.gz`

Layout has a reserved `payload-version` root entry containing the derived
version and otherwise mirrors the image: `rootfs/usr/local/bin/*`,
`rootfs/usr/local/libexec/*`, the full `rootfs/etc/s6-overlay/s6-rc.d` source
tree, and `rootfs/opt/blitz/skel/*`. A release may add or remove services. It
may not change the four frozen recovery definitions.
`payload-version` is outside `rootfs/` and therefore is not listed in
`manifest.files`; the updater verifies it separately against `manifest.version`.
Built by `control-plane/scripts/publish-box-payload.mjs` from the repo tree plus
the gateway Go binary (built by the same script via `go build`, or taken from a
`--binaries <dir>` produced in CI). `packages/box/Dockerfile` must build the
SAME layout into `/opt/blitz/payload/baked` from the same sources, so a fresh
box and an updated box are byte-identical for a given version. One function
produces the file list; both the Dockerfile stage and the publisher call it.

### 2.3 `daemon.tar.gz`

The installed Lody prefix: `lib/node_modules/lody/**`, `bin/lody`, and
the reserved root entries `daemon-version` and `daemon-protocol-version`,
as produced by the `daemon` stage of the Dockerfile (the tarball that
`scripts/lody-build-package.mjs` builds from `vendor/lody`, installed with
`npm ci` so npm enforces its shrinkwrap). Extracted to
`/opt/blitz/lody/<daemon version>/`; `/opt/blitz/lody/current` is the symlink
the s6 `lody-daemon` run script and the `lody` PATH shim resolve. Built on the
same node major as the image (22).

## 3. The box side

### 3.1 Layout

```
/opt/blitz/payload/baked/…            image layer, the payload built into this image
/opt/blitz/payload/current -> …       symlink; baked at first boot
/opt/blitz/payload/versions/<v>/      downloaded, verified payloads in the container layer
/opt/blitz/payload/state/state.json   { current, previous, pending?, failed?, unsentResult? }
/opt/blitz/lody/baked/, /opt/blitz/lody/current -> …, /opt/blitz/lody/<v>/
/usr/local/bin/<x> -> /opt/blitz/payload/current/rootfs/usr/local/bin/<x>   (every payload-owned entry)
```

A container restart keeps updater state and downloaded releases. A recreation
loses both, boots baked, and downloads the deployment pin on its first tick.

Image entries that the payload owns become symlinks into `current`, including
the whole s6 source tree at `/etc/s6-overlay/s6-rc.d`. The updater compiles the
selected tree and applies its service database, so a payload may add, remove,
or redefine services without rebuilding the base image. The four recovery
services (`cgroups`, `init-state`, `register`, and `payload`) have frozen
definitions so the base-owned updater can always recover a failed transition.

### 3.2 `blitz-payload` (node, CommonJS, no deps, runs as root under s6 `payload`)

Loop every `BLITZ_PAYLOAD_INTERVAL` (default 300 s; first tick 5 s after boot):

1. `GET /workspaces/self/box-config` with a bearer from `blitz-cred api-token`
   (NEVER the raw credential file — see docs/MEMORY-BOUNDARY.md on why raw
   readers go 401). The response gains `payload: {version, manifestUrl} | null`
   (additive; old boxes ignore it, old control planes omit it).
2. If `payload.version` equals `state.current`: nothing. Else **apply**:
   a. fetch manifest; validate against the contract; `minUpdater` check.
   b. fetch archives to `versions/<v>.staging/`; verify archive sha256, extract,
      verify every file sha256 and mode; rename to `versions/<v>/` (atomic).
      Daemon archive only if `daemon.version` differs from the running one.
   c. compute the changed set vs `current`; from `restart`, the services to restart.
      If activation requires a daemon restart, apply the whole-release idle
      policy in §3.3 before changing either live symlink.
   d. verify the frozen recovery floor, then compile the selected s6 tree into
      an anchored staging directory under `/run/s6`.
   e. atomically flip the payload and daemon links, complete the compiled
      database rename, run `s6-rc-update`, and apply remaining mapped restarts.
   f. health: within 60 s the gateway answers `127.0.0.1:7445/healthz` AND (if
      the daemon was restarted) the probe socket answers. Otherwise **rollback**:
      restore both links and the previous s6 database, converge the `user`
      bundle, apply valid previous-tree restarts, and check health again.
   g. `POST /workspaces/self/payload-result` `{version, daemonVersion, outcome, detail}`;
      both versions name the unit running after the attempt, and a failure
      names the attempted payload version in `detail`
      with outcome ∈ `booted | applied | deferred | rolled-back | unsupported | fetch-failed | verify-failed | start-failed | up-to-date`.
      Report `booted` on every boot (so the control plane learns the baked
      version); reserve `up-to-date` for a later tick whose pin already runs.
      `deferred` reports the still-running old versions and names the fully
      staged target and wait state in `detail`.
3. Keep `current` and `previous`; delete older `versions/*` and `.staging` leftovers.

Failed target versions are locally rate-limited. `verify-failed`, `rolled-back`,
`start-failed`, and `unsupported` persist
`failed: {version, outcome, at}` in `state.json`; the same pin is not
attempted or reported again for six hours. A different pin is attempted at
once, and returning the pin to the running version clears the failure.
The last unacknowledged result remains in `state.json`; each tick retries it
before fetching new configuration or replacing it with a newer result.
JSON responses are streamed into a 1 MiB cap rather than buffered first.

`/opt/blitz/payload/state/log` records the boot report, every outcome transition,
and an unchanged `tick: up-to-date <version>` heartbeat at most once per hour.

The supervised launcher and `blitz-payload tick` share one kernel-backed
`flock` at `/run/blitz-payload.lock`. A contended CLI tick exits 75. The
launcher waits up to 300 seconds, and s6 retries while an operator tick holds
the lock.

Invariants (each one a guest test): never a half-applied `current` (the symlink
flips once, after full verification); a crash at any step leaves either the old
or the new version running; a payload the updater cannot verify is never
executed; the updater itself never exits non-zero out of the loop (s6 would
spin); the box credential is obtained through `blitz-cred`; every outcome is
reported; a box with no control plane (self-host `docker run` with no origin)
idles on baked forever.

### 3.3 Daemon in place

Restarting the daemon kills its agent children (stdio; the sandbox `cgroup.kill`s
their leaves). E4 on the real box disproved the original re-dispatch assumption
for the daemon version pinned here: restarting a Claude session parked in
`requestPermission` ended its turn with `agent_disconnected`; daemon resume
logged `Failed to create session`, and the member had to re-send the turn.

Payload and daemon are one compatibility unit. The manifest carries both, and
payload-owned bridge or gateway code may require the new daemon protocol, so
"payload now, daemon later" is not accepted. When a verified release requires
a daemon restart, the updater defers the **whole activation**:

- Download, extract, and verify the payload and changed daemon first, then
  persist `{version, daemonVersion, readyAt}` without moving either `current`
  symlink. Report `deferred`, with the old running versions in the version
  fields, so the control plane can distinguish a waiting box from an
  up-to-date or failed box. A changed or removed pin drops that deferral and is
  evaluated immediately.
- On each normal updater tick, ask the daemon's bounded local `/state` probe
  once. Lody's `activeSessionCount` covers turns whose status is `running`,
  `requestPermission`, or `initializing`. Zero activates the whole release on
  that tick. A failed probe is treated as busy; an absent control socket is
  treated as idle.
- Do not block or internally poll the updater loop. If the box stays busy until
  `BLITZ_PAYLOAD_DAEMON_IDLE_WAIT` has elapsed since `readyAt` (default 4 h),
  activate and restart anyway. The `applied` detail calls this a forced daemon
  restart, includes the active-turn count and elapsed deferral, and warns that
  an in-flight turn may end `agent_disconnected` and need re-sending.
- The switch is `/opt/blitz/lody/current` + `s6-svc -r lody-daemon` (with the
  watchdog's SIGKILL escalation if the loop is blocked — reuse `restart_daemon`
  from `lody-watchdog`, or call the same sequence).
- The browser's data plane is `protocolVersion` 7; the control plane must not
  pin a daemon whose protocol the deployed webapp does not speak. v1: the
  publisher records `daemon.protocolVersion` in the manifest; the control plane
  refuses to pin a payload whose value differs from the webapp's constant
  (`vendor/lody/packages/shared/src/local-loro-data-plane.ts`).

Follow-up for Lody upstream, not part of this plan's updater change: determine
why Claude ACP resume fails with `Failed to create session` after a daemon
restart and whether it can gain the resume behavior observed from a Codex
session in the same experiment family.

### 3.4 What the watchdog, stats and rules become

`machine-stats` is reported by the dependency-free updater after each
successful authenticated five-minute tick. It measures the filesystem holding
`/opt/blitz/payload/state` and POSTs the percentage to the control plane; the
old box script and longrun are deleted. `rules` becoming a push through the
gateway remains out of scope. The watchdog stays local (kernel signals) with
its thresholds from `box-config`.

## 4. The control-plane side

- `BOX_PAYLOAD_REF` and `BOX_PAYLOAD_VERSION` sit next to `BOX_IMAGE_REF`;
  `box-config` answers `payload` from the pair. An empty ref produces
  `payload: null`, so boxes stay baked.
- `POST /workspaces/self/payload-result` writes `machines.payload_reported`,
  `machines.daemon_reported`, `machines.payload_outcome`, `payload_reported_at`
  (migration). `MachineView` gains `payloadVersion`, `daemonVersion`
  (required fields; wire-drift pins them).
- `scripts/publish-box-payload.mjs`: builds `payload.tar.gz` + `daemon.tar.gz`
  + `manifest.json` from a checkout and uploads under `box-payload/<version>/`
  (reuse `publish-box-image.mjs`'s R2 client and manifest-first ordering:
  archives before manifest, so a partial publish is never pinnable).
- `scripts/plan-box-payload.mjs`: derive `version` from inputs and check R2 for
  an existing manifest. The `canary.yml` payload job reuses or publishes it,
  then pins every merge to main. Base inputs alone change the image release.
- Rollout control v1: deployment-wide pin plus a per-machine `payload_hold`
  column an admin can set (`PATCH /machines/:id`), and `GET /workspaces/:id`
  shows each machine's versions and last outcome.

## 5. Self-host lab

Control plane `blitz-thinlab` in the canary Cloudflare account (D1
`blitz-thinlab`, R2 `blitz-thinlab-images`, tunnels on canary's zone),
`HETZNER_MACHINE_TYPES=cx23@hel1,cx33@hel1,cx43@hel1`, Lody on through box
config (`BOX_LODY_SESSIONS=1`), image + payload published to that R2 from the lab VM
`thinlab-01`. Workspaces are created by a human in the webapp; the experiments
drive the machine API and ssh into the boxes with the lab key.

## 6. Experiments (all against boxes with live agent sessions)

| # | Scenario | Pass |
|---|---|---|
| E1 | script-only payload while a turn is in flight | turn completes; new tab uses new script; outcome `applied`; nothing restarted but the services whose files changed |
| E2 | gateway binary changed | websockets reconnect < 10 s; tmux sessions intact; turn unaffected |
| E3 | daemon bundle changed, sessions idle | restart at once; sessions resume; no turn lost |
| E4 | daemon bundle changed, turn in flight | fully stages but reports `deferred`; neither payload nor daemon switches while the turn runs; after the turn completes, both switch within one updater tick, the daemon restarts, and the session remains intact. Forced-cap behavior is guest-tested because the live box env knob cannot be changed. Measured prior behavior: forcing a Claude restart mid-turn ended it `agent_disconnected` and required a member re-send |
| E5 | archive sha mismatch / file sha mismatch / bad manifest | `verify-failed`; `current` unchanged; nothing restarted |
| E6 | gateway that crashes on start | `rolled-back` within 90 s; previous version serving; terminals reconnect |
| E7 | VM reset mid-apply (Hetzner `reset`) | comes up on old or new, never half; state.json consistent; reports on boot |
| E8 | container replaced by an image update after payload updates | boots baked, re-applies the pin on first tick |
| E9 | control plane unreachable / 401 / 5xx | keeps current; bounded retries; no CPU spin; reports when back |
| E10 | downgrade to an older pinned payload | applies like any other version |
| E11 | five payloads in ten minutes | converges to the last; ≤ 2 versions kept; no leaked `.staging` |
| E12 | `minUpdater` above the box's | `unsupported`; control plane marks the machine as needing an image update |
| E13 | apply under memory pressure (a session running `npm test` on a cx23) | bounded (the updater lives in the system slice); no half state |
| E14 | two member machines in one workspace | each updates independently, both report |
| E15 | old control plane (no `payload` field) + new box | box idles on baked; nothing logged as error |
| E16 | box `stop`/`start` (same container) | keeps updater state, downloaded versions, and the selected `current` link |

Every experiment is a script under `packages/box/test/payload-lab/` that uses
the control plane API and ssh, asserts the pass column, and prints one line.
Iterate until the whole table passes three times in a row on two boxes.

## 7. Order of work

1. Contract + fixtures + schema types (blocks everything).
2. Publisher + planner scripts; Dockerfile restructure (`baked` layout, symlinks,
   one-liner `run` files, the `payload` service).
3. `blitz-payload` updater + guest tests for every invariant in §3.2.
4. Control plane: config var, `box-config` field, result route, migration,
   views, wire-drift, agent-api doc (`npm run openapi:generate`).
5. Daemon bundle build + in-place switch + idle wait.
6. Self-host deploy; image + payload publish; experiments E1–E16.
7. `canary.yml` payload job; CLAUDE.md; docs/BOX-IMAGE.md; DEPLOY-RUNBOOK.md.
