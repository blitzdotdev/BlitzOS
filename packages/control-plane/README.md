# control-plane

The workspace engine for fleets on your cloud.

- The four-call API: create (machine shape + ssh pubkey + optional volume +
  optional user-data) · poll (the only authoritative read) · destroy
  (idempotent, tombstone) · ssh (public 22, key-only, pinned host key).
- The server owns the workspace view. Clients render it. Monotonic revision.
- Two provider seams: `VmProvider` and `VolumeProvider`. Hetzner adapter
  included. Your cloud = one adapter file, not a fork.
- Volumes are raw cloud primitives, passed through — no shadow tables. A
  volume survives workspace destroy.
- Readiness = cloud-init `phone_home` to a single-use URL. The response
  delivers the box credential, so hosted enrollment needs no human.
- Sessions: operator key → opaque server session → optional passkey.
- The broker registry: pubkeys and routing only, never a credential. Broker
  boxes pull their own member slice; no box can list the fleet.

Status: pre-build. Design record: `TODO.md`.
