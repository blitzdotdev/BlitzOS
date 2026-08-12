# oss/control-plane — blitz core workspace engine

Open core. The closed control plane imports it and adds around it.
Inclusion test: workspace mechanics = core. Tenancy, money, fleet ops = closed.
Derived 2026-08-11. Map: session scratchpad `codex-cp-carve.txt`.
Decisions: `sessions/2026-08-11-box-redesign-acp-docker.md`.

## In core

- Four-call API:
  - create: machine shape + caller SSH pubkey. Optional: volume ref, cloud-init
    user-data. The provision flow mounts the volume. Never put secrets in
    user-data. The VM can read user-data from inside.
  - poll: the only authoritative read.
  - destroy: idempotent. Result: tombstone. A mounted volume detaches and survives.
  - SSH: public port 22. Key-only OpenSSH. Pinned host key. No relay.
- Workspace view. The server owns it. The client renders it. Fields: `phase`,
  `canObserve`, `retryAction`, `launchable`, monotonic `revision`,
  `ssh {host, port, user, hostPublicKey}`.
  Ratified 2026-08-11: `phase` = `creating | ready | destroying | destroyed |
  error`. `retryAction` = `poll | destroy | create | null`. `destroyed` is the
  only terminal phase. Transitions: creating → ready → destroying → destroyed;
  creating → error → destroying → destroyed.
- Volumes: a raw primitive. The EC2/EBS shape. A network volume survives workspace
  destroy. Reference one at create. Routes: `POST/GET/DELETE /volumes` =
  passthrough on `VolumeProvider`. No volumes table (2026-08-11): the cloud
  holds volume truth; the workspace row keeps one column, the mounted volume
  ref. Tenancy/ownership tables are a closed-side add.
  No park verbs. No attach/detach operations in the API.
- Two provider seams. Separate interfaces. Core-package users write their own
  cloud adapters (AWS EBS, GCP PD, …):
  - `VmProvider`: `capabilities` · `listMachineTypes` · `createVm` · `destroy` · `inspect`
  - `VolumeProvider`: `createVolume` · `attachVolume` · `detachVolume` ·
    `deleteVolume` · `listVolumes` (2026-08-11: the UI volume picker reads it)
  - Only the provision/destroy flows call attach/detach. `shutdown` is removed:
    zero callers without park.
- Hetzner adapter: open. Plain hcloud calls. Nothing secret in it.
- Sessions: opaque hashed rows. Standalone auth = one operator API key. The
  principal source is a seam. The closed side fills it with GitHub identity.
  Optional passkey for the standalone cockpit (decided 2026-08-11): register
  under an operator-key session; later logins assert it. Stock WebAuthn.
  Sessions stay opaque hashed rows.
- Credential broker registry. Purpose: a subscription account can auth agents in
  every workspace its owner spawns.
  - Core holds pubkeys + routing only. Never a credential.
  - A workspace registers mint/deposit pubkeys. The owner comes from the
    authenticated box row. Never from the body.
  - Broker boxes PULL their member/key list. Feed auth = the box OAuth access
    token (2026-08-11: one token family; the separate pull token is deleted).
    ETag/304. The pull shape stops one rogue box from listing the fleet.
  - Mint = forced-command SSH on the broker box.
  - Members use the sessions principal seam.
  - No key ceiling (founder, 2026-08-11). `expires_at` leaves the schema. A key
    is valid while the feed serves it. Revocation = ON DELETE CASCADE + the feed.
  - Enrollment API: register/remove a broker box (host, port, SSH host pubkey)
    + set the broker role flag. A broker box is a box: it enrolls through the
    same device flow; no separate pull token exists. This replaces raw D1
    inserts. `blitz-broker enroll` calls it.
  - Registration auth = the box OAuth token (fixed 2026-08-11; the earlier
    keypair line contradicted box decision 2). Rule: HTTP plane = tokens.
    SSH plane = keypairs.
  - Broker fleet ops stay closed. The Go daemon is open. Record:
    `packages/oss/broker/TODO.md`.
- Box identity: device-flow enrollment endpoints + box OAuth tokens.
  Short-lived access + rotating refresh. Opaque hashed rows, constant-time
  compare. ONE token family serves every box→CP call: registry registration,
  the broker pull feed (2026-08-11).
- Readiness: cloud-init `phone_home`, one shot (decided 2026-08-11). The POST
  carries "boot finished" + the SSH host public keys. Target = a single-use
  capability URL, minted per provision. User-data is readable inside the VM,
  so the token must die after one use. The module retries by itself. Success
  flips `phase` to `ready` and fills `ssh.hostPublicKey`. The RESPONSE carries
  the box credential (2026-08-11): the bootstrap writes it 0600 on the state
  volume before the container starts, so hosted enrollment needs no human.
  Standalone keeps the device flow. No periodic heartbeat. No host CA.
- Janitors as exported functions: orphan destroy, invariant sweep. Cron
  scheduling is deployment glue.

## Not in core (closed imports core and adds these)

- Orgs, members, roles, invites. GitHub OAuth + App + git-token minting.
- Stripe, claims, seats, billing.
- Operator/platform routes, canary, prod ledger.
- Ingress authz/map feed. The ingress package is closed.
- Warm-pool policy. Closed satisfies core `createVm` from its pool.

## Deleted (2026-08-11)

- Park/resume + the DriveStore product layer: drive verbs, auto-park policy,
  Home, restic. Humans keep the VM running. Data in/out is caller-owned: boot
  script at create, then ssh/rsync/rclone. For data that must outlive a
  workspace: use a volume. Keys stay on the workspace disk. The no-custody rule
  does not change.
- Blueprints. The concept, everywhere: routes, table, create-path requirement,
  `CreateWorkspaceDialog` machinery. Create takes the machine shape inline.
- BYOM lease/heartbeat/offline/registry, `SelfProvider`, exec jobs, activity
  reports, legacy `/api` aliases, `/cli-auth` token-in-URL,
  `github_identity_organizations`, fork-era compatibility (after the data audit).

## Decided 2026-08-11 (was open questions)

- Enums ratified. See the workspace view bullet. The UI carve is unblocked.
- Readiness = cloud-init `phone_home`. See the readiness bullet.
- Tombstones: keep forever. No purge mechanism in core. The closed side may
  add a purge policy if hosted scale needs one.
- Cron default: hourly janitor + one daily deep sweep. Today's shape, minus
  park recovery. Core exports the functions; the deployment schedules them.
- Second pass, cross-package synthesis (2026-08-11): one box→CP token family
  (pull token deleted) · registration auth = box OAuth token · phone_home
  response delivers the box credential · volumes table deleted, `listVolumes`
  joins the seam · view types + enums move to the shared `schema` package
  (cp implements it, ui imports it, box tests against it). Front door:
  `packages/oss/README.md`.

No open questions remain.
