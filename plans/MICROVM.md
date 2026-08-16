# MicroVM provisioning: <5 s end-to-end

Goal: API call → box running, credentials delivered, ssh reachable — under 5 seconds. Today's measured path (Hetzner VM per workspace) is ~130 s and has a hard floor of 45–60 s in Hetzner allocation alone. Sub-5 s requires owning the host layer.

## The model

A pool of pre-provisioned **hosts** (Hetzner Cloud big instances — they expose KVM — or Robot bare metal) runs a new **host agent**. Each workspace becomes a **microVM** (Firecracker-class) on a host: ~150–300 ms boot, hardware isolation, copy-on-write rootfs. The expensive work (host boot, image distribution) moves off the critical path to host-warm time.

## Where the 130 s goes

| Today (per workspace) | MicroVM model |
|---|---|
| Hetzner allocate + Ubuntu boot ~60 s | Host already running; placement decision <10 ms |
| cloud-init + docker install ~9 s | Gone — no cloud-init, no docker install in the guest path |
| 640 MB image pull + load ~58 s | Rootfs already on the host; per-workspace CoW clone <100 ms |
| box start + health ~4 s | Guest init (s6) up in ~1 s |
| phone-home <1 s | Same contract, same speed |

Cold budget: ~2–3 s. With Firecracker snapshot-restore (warm pool of pre-booted, paused guests): sub-1 s.

## What blitz-core needs, by layer

1. **`MicrovmPoolProvider`** — a new `VmProvider` implementation. The four-call API, phases, phone-home, ssh-view schema, and the frozen e2e gate all stay identical. This is the payoff of the provider seam: no control-plane surgery, one new adapter.
2. **Host agent** (new package, Go, broker-style auth patterns): supervises microVMs on one host — create/destroy in <1 s, capacity heartbeat to the control plane, rootfs cache management, TAP networking + port mapping. Talks the existing HTTP-token plane.
3. **Rootfs pipeline**: CI converts the existing box OCI image into a versioned read-only rootfs (erofs/ext4). Hosts prefetch new versions in the background. Per-workspace = CoW overlay. The box image already IS the workspace definition — this is a format conversion, not a redesign. Bonus: DinD's `--privileged` requirement disappears; dockerd runs inside a hardware-isolated guest.
4. **Guest init**: the image's s6 graph becomes PID-1 territory (init shim + pinned kernel). Bring-up: static network from kernel args, sshd (pregenerated or ~100 ms keygen), three surfaces, then the same phone-home with box host keys.
5. **Scheduler + pool autoscaler** in the control plane: hosts table (capacity, heartbeats, image versions), placement (<10 ms), and a slow-path autoscaler that grows/shrinks the host pool using the EXISTING Hetzner adapter — the current provider gets demoted from "per workspace" to "per host", layered under the new one.
6. **Reachability decision** (the real design fork): microVMs can't each get a public IPv4 in 5 s. Options: (a) host port-mapping — ssh host:220NN → guest:22, simplest, v1; (b) an ingress layer (the open-core cousin of blitz-v2-ingress, which already does `*.ws` routing in v2). The workspace view's host+port fields already carry either shape.
7. **Volumes**: Hetzner volumes attach to hosts, not guests. Keeping "state survives destroy" means either workspace-to-host affinity (recreate lands on the host holding its data) or network-exported slices (virtiofs/NBD over a host-attached volume). V1: affinity + documented constraint.

## What does not change

Schema, webApp, auth, broker, ACP, bootstrap enrollment contract, the gate e2e (s5 just gets fast). The whole 9/9 suite remains the acceptance test, plus a new latency assertion and density/failure suites.

## Order of work (dependencies, no estimates)

1. Rootfs conversion pipeline from the existing image (independent, testable locally in a VM).
2. Host agent + local single-host e2e (a Hetzner host running real microVM workspaces).
3. `MicrovmPoolProvider` + hosts table + placement; gate green against one host.
4. Port-map reachability; then pool autoscaling via the layered Hetzner adapter.
5. Volume affinity. 6. Warm-pool snapshots for sub-1 s. 7. Ingress integration when the open-core ingress question is settled.

## Risks / honest notes

- Density economics: box + inner dockerd wants ~0.5–1 GB per workspace; hosts are RAM-bound.
- Network namespace setup must be deterministic and fast; this is where most "microVM in 5 s" projects bleed.
- Nested-KVM performance on Hetzner Cloud instances needs a benchmark before committing to cloud hosts vs Robot bare metal.
- The host fleet is new operational surface (upgrades, drain, failure) — the janitor/labels discipline from this session extends to hosts.
