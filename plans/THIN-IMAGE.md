# THIN-IMAGE: a box that updates in place, on the control plane's schedule

Status: design + build plan, 2026-09-04. Branch `feat/thin-image-payload`.
Owner of the schedule: the control plane. Owner of nothing: the box.

## 0. The rule

A box image is rebuilt for exactly two reasons: the base changed (OS packages,
node, docker, s6, the static binaries, the updater itself) or a Lody upstream
bump changed something the daemon bundle cannot carry. Everything else is a
**payload** the control plane publishes and every box applies in place, with
bounded, known interruption, and rolls back by itself when it does not come up.

Why: today the only update path replaces the container
(`core/bootstrap.ts` host updater, `blitz-box-run`), which kills every session,
terminal and agent on the box — an update is a reboot by another name. A
customer never reboots a box; we force it, and a forced reboot that lands in a
stalled box strands them (2026-09-04, `docs/MEMORY-BOUNDARY.md`). The agent
CLIs already update themselves in place under the uid-1000 npm prefix with zero
interruption; this generalises that to everything we ship.

## 1. What is base, what is payload

| Base (image only) | Payload (in place) |
|---|---|
| Debian + node 22 + docker static + s6-overlay | every script under `rootfs/usr/local/{bin,libexec}` |
| cloudflared, ttyd, dufs | s6 `run`/`up` scripts of EXISTING services (the service SET is base) |
| the payload updater `blitz-payload` + its `payload` s6 service | `blitz-box-gateway`, `blitz-cred` (linux/amd64; arm64 later) |
| `/opt/blitz/npm` prefix with claude, codex, ws | the Lody **daemon bundle** (the patched `lody` install) |
| a baked copy of the current payload + daemon bundle (§3) | agent rules skeleton, `env.defaults` for services |

`claude`/`codex` keep self-updating as today; not part of this.

## 2. Artifacts and the contract

Two R2 objects per release, published by the control plane's tooling, pinned
by deploy vars, served by the Worker under `/box-payload/<version>/…` exactly
the way `/box-image/<releaseId>/…` is served today (`core/box-image-routes`).

### 2.1 `manifest.json` (contract: `box-payload v1`)

```json
{
  "version": "20260904T2130Z-9f3c1a2b",
  "createdAt": 1788550000000,
  "minUpdater": 1,
  "files": [{ "path": "rootfs/usr/local/libexec/blitz-term", "sha256": "…", "mode": "0755" }],
  "archive": { "url": "…/box-payload/<version>/payload.tar.gz", "sha256": "…", "bytes": 1234 },
  "daemon": { "version": "0.88.1+blitz.3", "url": "…/box-payload/<version>/daemon.tar.gz", "sha256": "…", "bytes": 1234 },
  "restart": { "gateway": ["rootfs/usr/local/bin/blitz-box-gateway"], "…": [] }
}
```

- `version` is the SHA-256 of a canonical encoding of the sorted
  `(path, sha256, mode)` records in `files`, the daemon archive SHA-256 (or
  `none`), and the sorted `restart` map. It never includes Git history,
  `createdAt`, build scripts, or base-owned files.
- `files` lists every file in `payload.tar.gz` with its digest; the updater
  verifies each file after extraction, not just the archive.
- `daemon` is a separate archive so a script-only release does not re-download
  the daemon. Its `version` is the npm version plus a `+blitz.N` patch-set
  serial; two releases with the same daemon version share the object.
- `restart` maps each s6 service to the payload paths it depends on; the
  updater restarts a service iff one of its paths changed between the running
  payload and the new one. This is the producer's knowledge (which script is
  which service), so it lives in the manifest, not in the updater.
- `minUpdater`: an updater older than this reports `unsupported` and applies
  nothing; the control plane then knows an image update is required.

Fixtures: `packages/schema/fixtures/box-payload/` — valid manifests, each
malformed field, a `minUpdater` too high, a manifest whose `restart` names an
unknown service. Producer conformance in `control-plane/test`, consumer
conformance in `box/guest-tests/test` running the REAL updater. Add the row to
CLAUDE.md's contract table. Types in `packages/schema/src/box-payload.ts`,
wire copy pinned by `wire-drift.test.ts`.

### 2.2 `payload.tar.gz`

Layout has a reserved `payload-version` root entry containing the derived
version and otherwise mirrors the image: `rootfs/usr/local/bin/*`, `rootfs/usr/local/libexec/*`,
`rootfs/etc/s6-overlay/s6-rc.d/<service>/{run,up}` (only for services that
exist in the base), `rootfs/opt/blitz/skel/*`, `rootfs/etc/blitz/env.defaults`.
`payload-version` is outside `rootfs/` and therefore is not listed in
`manifest.files`; the updater verifies it separately against `manifest.version`.
Built by `control-plane/scripts/publish-box-payload.mjs` from the repo tree plus
the two Go binaries (built by the same script via `go build`, or taken from a
`--binaries <dir>` produced in CI). `packages/box/Dockerfile` must build the
SAME layout into `/opt/blitz/payload/baked` from the same sources, so a fresh
box and an updated box are byte-identical for a given version. One function
produces the file list; both the Dockerfile stage and the publisher call it.

### 2.3 `daemon.tar.gz`

The installed, patched Lody prefix: `lib/node_modules/lody/**`, `bin/lody`, and
the reserved root entries `daemon-version` and `daemon-protocol-version`,
as produced by the `vendors` stage of the Dockerfile today (npm install of the
pinned version + the five patch scripts + their guards). Extracted to
`/opt/blitz/lody/<daemon version>/`; `/opt/blitz/lody/current` is the symlink
the s6 `lody-daemon` run script and the `lody` PATH shim resolve. Built on the
same node major as the image (22).

## 3. The box side

### 3.1 Layout

```
/opt/blitz/payload/baked/…            image layer, the payload built into this image
/opt/blitz/payload/current -> …       symlink; baked at first boot
/var/lib/blitz/payload/versions/<v>/  downloaded, verified payloads (volume; survives VM replace)
/var/lib/blitz/payload/state.json     { current, previous, lastOutcome, lastAttemptAt, failed? }
/opt/blitz/lody/baked/, /opt/blitz/lody/current -> …, /var/lib/blitz/daemon/versions/<v>/
/usr/local/bin/<x> -> /opt/blitz/payload/current/rootfs/usr/local/bin/<x>   (every payload-owned entry)
```

Image entries that the payload owns become symlinks into `current`. The s6
service directories stay in the image (the service set is base); their `run`
files become `exec /opt/blitz/payload/current/rootfs/etc/s6-overlay/s6-rc.d/<svc>/run "$@"`
one-liners, so a payload can change what a service does but not which
services exist. (Adding a service is an image change, by design, for v1.)

### 3.2 `blitz-payload` (node, CommonJS, no deps, runs as root under s6 `payload`)

Loop every `BLITZ_PAYLOAD_INTERVAL` (default 300 s; first tick 60 s after boot):

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
   d. `ln -sfn` the new version onto `current` via a temp link + `rename(2)`.
   e. restart affected services with `s6-svc -r`; for `lody-daemon` see §3.3.
   f. health: within 60 s the gateway answers `127.0.0.1:7445/healthz` AND (if
      the daemon was restarted) the probe socket answers. Otherwise **rollback**:
      re-point `current` to `previous`, restart the same services, health again.
   g. `POST /workspaces/self/payload-result` `{version, daemonVersion, outcome, detail}`
      with outcome ∈ `booted | applied | rolled-back | unsupported | fetch-failed | verify-failed | start-failed | up-to-date`.
      Report `booted` on every boot (so the control plane learns the baked
      version); reserve `up-to-date` for a later tick whose pin already runs.
3. Keep `current` and `previous`; delete older `versions/*` and `.staging` leftovers.

Failed target versions are locally rate-limited. `verify-failed`, `rolled-back`,
`start-failed`, and `unsupported` persist
`failed: {version, outcome, at, attempts}` in `state.json`; the same pin is not
attempted or reported again for six hours. A different pin is attempted at
once, and returning the pin to the running version clears the failure.

`/var/lib/blitz/payload/log` records the boot report, every outcome transition,
and an unchanged `tick: up-to-date <version>` heartbeat at most once per hour.

Invariants (each one a guest test): never a half-applied `current` (the symlink
flips once, after full verification); a crash at any step leaves either the old
or the new version running; a payload the updater cannot verify is never
executed; the updater itself never exits non-zero out of the loop (s6 would
spin); the box credential is obtained through `blitz-cred`; every outcome is
reported; a box with no control plane (self-host `docker run` with no origin)
idles on baked forever.

### 3.3 Daemon in place

Restarting the daemon kills its agent children (stdio; the sandbox `cgroup.kill`s
their leaves) and the daemon re-dispatches in-flight turns on resume. So:

- Prefer an idle moment: ask the daemon over its control socket for the session
  list (`session-control`, the same door `blitz-lody-bridge` proxies); "idle" =
  no session in a running turn. Wait up to `BLITZ_PAYLOAD_DAEMON_IDLE_WAIT`
  (default 10 min), polling; then restart anyway and say so in `detail`.
- The switch is `/opt/blitz/lody/current` + `s6-svc -r lody-daemon` (with the
  watchdog's SIGKILL escalation if the loop is blocked — reuse `restart_daemon`
  from `lody-watchdog`, or call the same sequence).
- The browser's data plane is `protocolVersion` 7; the control plane must not
  pin a daemon whose protocol the deployed webapp does not speak. v1: the
  publisher records `daemon.protocolVersion` in the manifest; the control plane
  refuses to pin a payload whose value differs from the webapp's constant
  (`vendor/lody/packages/shared/src/local-loro-data-plane.ts`).

### 3.4 What the watchdog, stats and rules become

Out of scope for the first cut but designed for: `machine-stats` becomes a
gateway `/stats` read pulled by a control-plane cron; `rules` becomes a push
through the gateway; both delete a box script and a box-credential reader. The
watchdog stays local (kernel signals) with its thresholds from `box-config`.

## 4. The control-plane side

- `BOX_PAYLOAD_REF` var (manifest URL) next to `BOX_IMAGE_REF`; `box-config`
  answers `payload` from it. Empty var → `payload: null` → boxes stay baked.
- `POST /workspaces/self/payload-result` writes `machines.payload_reported`,
  `machines.daemon_reported`, `machines.payload_outcome`, `payload_reported_at`
  (migration). `MachineView` gains `payloadVersion`, `daemonVersion`
  (required fields; wire-drift pins them).
- `scripts/publish-box-payload.mjs`: builds `payload.tar.gz` + `daemon.tar.gz`
  + `manifest.json` from a checkout and uploads under `box-payload/<version>/`
  (reuse `publish-box-image.mjs`'s R2 client and manifest-first ordering:
  archives before manifest, so a partial publish is never pinnable).
- `scripts/plan-box-payload.mjs`: derive `version` from inputs, check R2 for an
  existing manifest, reuse or publish — the same shape as `plan-box-image.mjs`
  so `canary.yml` gains a `payload` job beside `image`. Every merge to main
  publishes a payload and pins it; the image job only runs when base inputs
  change (Dockerfile base stages, updater, service set).
- Rollout control v1: deployment-wide pin plus a per-machine `payload_hold`
  column an admin can set (`PATCH /machines/:id`), and `GET /workspaces/:id`
  shows each machine's versions and last outcome.

## 5. Self-host lab

Control plane `blitz-thinlab` in the canary Cloudflare account (D1
`blitz-thinlab`, R2 `blitz-thinlab-images`, tunnels on canary's zone),
`HETZNER_MACHINE_TYPES=cx23@hel1,cx33@hel1,cx43@hel1`, Lody on
(`BLITZ_LODY_SESSIONS=1`), image + payload published to that R2 from the lab VM
`thinlab-01`. Workspaces are created by a human in the webapp; the experiments
drive the machine API and ssh into the boxes with the lab key.

## 6. Experiments (all against boxes with live agent sessions)

| # | Scenario | Pass |
|---|---|---|
| E1 | script-only payload while a turn is in flight | turn completes; new tab uses new script; outcome `applied`; nothing restarted but the services whose files changed |
| E2 | gateway binary changed | websockets reconnect < 10 s; tmux sessions intact; turn unaffected |
| E3 | daemon bundle changed, sessions idle | restart at once; sessions resume; no turn lost |
| E4 | daemon bundle changed, turn in flight | waits for idle up to the cap, then restarts; the turn is re-dispatched; measured gap reported |
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
| E16 | box `stop`/`start` (volume kept) | comes back on baked, then re-applies from `versions/` without re-downloading |

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
