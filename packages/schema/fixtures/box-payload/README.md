# Box-payload v2 fixtures

This corpus defines the `box-payload v2` boundary.
The publisher and updater share this boundary.
Manifest fixtures live under `valid/` and `invalid/`.
Updater result fixtures live under `payload-result/`.
Every file contains JSON.
`cases.json` maps each invalid fixture to its rejected field.

A manifest carries a safe version token.
It carries a positive creation time and updater protocol.
`files` lists every regular payload file below `rootfs/`.
`directories` lists empty directories below `rootfs/`.
The parser accepts an omitted `directories` field as an empty list.
The publisher always writes the field.
The archive reserves `payload-version` at its root.
That stamp contains `manifest.version` followed by one newline.
The stamp stays outside `rootfs/` and `manifest.files`.

Digests use 64 lowercase hexadecimal characters.
Modes use four octal characters.
The publisher maps source executable bits to `0755` and other regular files to `0644`.
It refuses symlinks and non-regular source files.
Artifact URLs use absolute HTTP or HTTPS URLs.
Paths contain no empty, dot, or parent segments.

Restart keys name longruns in the manifest's service tree.
Each key requires matching `run` and `type` files.
The updater verifies that each extracted type reads `longrun`.
Protocol 2 has no fixed restart vocabulary.

The service tree lives under `rootfs/etc/s6-overlay/s6-rc.d/`.
Protocol 2 manifests require updater protocol 2.
Published protocol 2 manifests remain parseable by protocol 1 updaters.
Protocol 1 ignores the additive `directories` field.
It reports `unsupported` before downloading the archive.
Protocol 2 boxes also refuse protocol 1 releases before downloading archives.
The control plane must not pin protocol 1 for rollback on protocol 2 images.
The publisher emits only protocol 2 releases.
The planner reuses only protocol 2 manifests with publisher-required fields.

The updater compiles into a reserved `.blitz-db-staging-<pid>-<nonce>` directory.
It renames the database only after compilation succeeds.
Initialization protects the live target before removing that anchored staging namespace.
Rollback restarts only selected longruns present in the previous tree.
Rollback checks Lody health for every forward restart cause present in the previous tree.
Failed rollback keeps pending state until every recovery step succeeds.
A failed recovery reports `start-failed` and retries rollback on the next tick.
The updater queues that result when it cannot reach the control plane.
CLI `tick` exits nonzero with the rollback reason.
Database cleanup retains committed and live compiled targets.
It also retains actual current links and both pending release targets.
The supervised launcher and CLI ticks share one kernel-backed `flock`.
An active CLI tick can delay payload-service startup for its full remaining runtime.
Each launcher attempt waits at most 300 seconds.
While the lock stays held, s6 restarts the launcher and retries.
CLI lock refusal exits 75 and tells the operator to stop the service or wait.

A container restart compiles the tree selected by `current`.
Pending recovery resumes from image-layer state regardless of partially restored links.
A container recreate loses updater state and downloaded releases together.
It starts from baked and downloads the current pin on its first tick.

`valid/min-updater-unsupported.json` requires protocol 3.
Parsing validates its shape without claiming support.
`valid/single-file.json` preserves a protocol 1 compatibility example.

Unknown object members remain tolerated by the box parser.
The publisher rejects unknown members.
This preserves forward compatibility without weakening production output.

Result outcomes include `booted`, `applied`, `deferred`, and `rolled-back`.
They also include `unsupported`, `fetch-failed`, and `verify-failed`.
The remaining outcomes are `start-failed` and `up-to-date`.
Result versions identify the releases selected by the current links.
When a selected release stamp is unreadable, payload and daemon identities independently
fall back to matching pending or committed endpoint metadata.

The control-plane conformance test reads every fixture.
The guest conformance test runs the real updater parser.
