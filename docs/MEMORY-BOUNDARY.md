# The box memory boundary

Every workspace VM runs one box container, and until this boundary existed
the container was one flat memory pool. This page records the failure that
motivated the split, the design, the knobs, and how to re-run the load
campaign that sized them.

## The failure

A workspace under memory pressure has two ways to die, and the loud one is
the rare one:

- **Reclaim stall** (the common one). The VM has no swap, so the kernel
  drops page cache and then spins in direct reclaim. Every process stalls —
  including cloudflared, which stays alive but stops answering tunnel
  heartbeats. The workspace reads "connecting". `dmesg` shows nothing,
  `docker ps` shows a healthy container. Nothing restarts anything, because
  nothing died.
- **OOM kill** (the loud one). The kernel picks the biggest RSS. That is
  usually the offending build or agent, but dockerd, the Lody daemon, and
  container PID 1 are all legal victims. A PID 1 kill restarts the whole box
  and loses every tmux session in it.

## The boundary

```
VM (Hetzner cloud server, Ubuntu 24.04)
│  zram swap, 25% of RAM        — pressure degrades before it kills
│  host reserve 512 MB          — host sshd + dockerd + blitz-box-update
│                                 survive any box-internal storm
└── box container   --memory <RAM-512M> --memory-swap <+2G> --pids-limit 8192
    │
    │  s6 oneshot `cgroups` runs blitz-cgroup init before anything else:
    │  drain every pid out of the container root, then delegate +memory +pids
    │
    ├── blitz-system.slice        memory.min 256M (measured: no flip down to 128M; 256M is ~3x the protected set) · oom_score_adj -900 · pids 512
    │     s6 tree, cloudflared, gateway, sshd, dufs, ttyd, watch
    │     — the services that carry the box to its user
    │
    └── blitz-user.slice          memory.max total-min-headroom · high = max-500M
          pids 4096 · swap 2G      — everything a member's work can grow
          ├── tab-<session>        one per terminal tab      oom.group=1
          ├── ssh-<pid>            one per ssh session       oom.group=1
          ├── lody.scope           session agents (ACP children) oom.group=1
          ├── rc.scope             claude.ai Remote Control  oom.group=1
          ├── dockerd.scope        the DinD daemon itself
          └── docker.slice         every inner container     max = user/2, oom.group=1
```

`memory.min` closes the stall: the kernel must not reclaim the protected
set, so cloudflared keeps answering while user work thrashes. `memory.max`
plus `oom.group` closes the wrong-victim kill: a runaway dies as one unit
inside its own leaf, and the tab next door survives. `memory.high` sits a
band below the ceiling so a runaway throttles visibly before it dies.

## Where placement happens, and why there

| Work enters through | Placed by | Why there |
|---|---|---|
| Terminal tab | the tmux **pane command** in `blitz-term` | tmux forks panes from its server, not from the launcher |
| SSH / sftp | `ForceCommand /usr/local/libexec/blitz-ssh-session` | sessions fork from sshd, which lives in the protected slice |
| Session agents | the `lody-daemon` s6 `run` | the daemon spawns each ACP agent beyond any wrapper |
| Remote Control | its s6 `run` | it drives a full agent |
| Inner containers | `dockerd --cgroup-parent` | dockerd otherwise creates cgroups outside every limit |

uid 1000 is delegated the container-root `cgroup.procs` and the user slice —
enough to move its own work between leaves it owns, and structurally unable
to park anything in the protected slice, which stays root-owned.

## Verified invariants

- **docker exec survives delegation.** runc attaches exec processes to the
  container init's cgroup (the system slice), not the namespace root, so the
  no-internal-process rule never breaks exec. Proved on a real cx23
  ("assertion zero" in the lab) — this was the one fact no nested
  environment could answer, and the whole design rested on it.
- **A box that cannot own cgroups boots flat.** Unprivileged containers and
  box-in-box dev workspaces get a clean bail: no slice directory, no join
  noise, every `blitz-cgroup enter` a silent passthrough. The smoke suite
  asserts the full layout where the memory controller is delegated and
  asserts the clean bail where it is not.
- **Every knob is an env var** (`BLITZ_CG_*`, see `blitz-cgroup`), read from
  the container environment, overridable per box via
  `/etc/blitz/box-limits.env` on the VM without an image rebuild.

## The load campaign

`packages/box/test/` carries the whole rig:

- `memory-load.sh` — runs ON the VM; 8 scenarios (agent balloon, parallel
  build, DinD bomb, cache flood, fork storm, slow leak, combined, stall
  edge). The oracle is an out-of-box probe of the box's sshd plus cgroup
  accounting read from the host cgroupfs — never `docker exec`, which is
  itself under test.
- `hetzner-load-lab.sh` — orchestrates real cx23 VMs. Destructive calls are
  double-constrained (label `blitz-test=oom` AND name prefix `oomtest-`),
  the pre-run inventory is diffed at teardown, and only the orchestrator
  holds the API key; run agents drive load purely over ssh.
- `tunnel-oracle.sh` — a real cfd_tunnel through the box under test, polled
  from outside. Any HTTP status is a live path; only transport failure is a
  dead one.
- `analyze-load.py` — folds probe, cgroup, dmesg, and tunnel logs into one
  verdict table per arm.

Pass criteria: P1 host probe gap < 2 s, P2 zero system-slice OOM kills,
P5 a new session within 30 s of any kill, P6 tunnel error rate < 1%.

Results and the sizing rationale for the shipped defaults live in the PR
that introduced this page.
