# oss/box — one OCI image, open. Install = docs.

Box and box installer live here. Design record:
`sessions/2026-08-11-box-redesign-acp-docker.md`.
Carve 2026-08-11. Full report: session scratchpad `codex-box-carve.txt`.
Inventory: `packages/box` 31 files / 10,389 LOC. `packages/box-installer`
17 files / 6,071 LOC. Finding map: 42 Lane 1+5 findings. 29 die by design.
13 carry as FIX.

## In core (open)

- One Linux OCI image. Platforms: `linux/amd64` + `linux/arm64`. Published
  immutably. Run by digest. Mac runs the same Linux image. This replaces both
  native installers (~1,275 duplicate lines), curl|sh, the host tarball,
  NodeSource, and self-update.
- Four externally reachable surfaces: key-only sshd · ttyd+tmux · ACP session
  endpoint · the files HTTP origin, which carries WebDAV, port discovery, and
  preview proxying. No heartbeat. No exec jobs. No activity. No layout REST.
  No volume API.
- The ACP session actor:
  - One actor per session. One serialized turn queue. N subscriber sockets.
  - The server creates session and turn IDs. Each turn gets exactly one
    terminal state.
  - Durable journal: SQLite on the state volume, monotonic `seq`.
  - `session/load` replays the journal. A prompt never replays by itself.
  - Socket loss removes one subscriber. Nothing more. Cancel is an explicit
    ACP call.
  - Use the official `@agentclientprotocol/sdk`, pinned. Never build an
    "ACP-plus".
  - Transport: WS listener on 7444 (decided 2026-08-11), pinned to the draft
    remote-transport profile + its conformance fixtures.
- Codex = pinned official `codex app-server` subprocess. stdio or unix socket.
  Child of the actor. No rollout parsing. No fabricated diffs. No static model
  catalogs.
- Claude = pinned official Agent SDK. With a broker configured, the actor gets
  a token from `blitz-cred token claude` before each turn, async. With no
  broker, the SDK reads the native HOME files on the state volume
  (2026-08-11). Then it resumes the provider session. A mint failure ends the
  turn visibly. It never replays the prompt.
- `blitz-cred` (register/token/watch) comes from the open broker module. This
  repo keeps no second shell implementation.
- One state volume at `/var/lib/blitz`: identity keypair + enrollment, SSH host
  keys, authorized_keys, broker client state, HOME, session journal. The
  workspace directory is a caller bind mount at `/workspace`.
- One unprivileged `blitz` user runs the work. Root does init, sshd, and UID
  mapping only. No password login. No root login.
- Supervision: pinned s6-overlay. Service graph: init-state → enroll (first
  start) → `blitz-cred register` → sshd · ttyd · actor · dufs · HTTP gateway ·
  `blitz-cred watch`. No CP config on the volume → enroll, register, and watch
  are SKIPPED (2026-08-11). The box runs alone: `docker run` → working box,
  zero accounts; agent credentials = native HOME files (`claude login` over
  ssh, once). The CP + broker are an opt-in overlay.
- Image contents, all pinned by digest or version: `node:22-bookworm-slim` base
  (Node stays: the actor and the Claude SDK are Node; NodeSource dies),
  openssh, tmux, git, ttyd (checksummed release), dufs 0.46.0 (checksummed
  release), Claude Code,
  `@openai/codex`, compiled actor + lockfile, static `blitz-cred`, and the
  static box HTTP gateway.
- Files server: dufs 0.46.0, pinned and checksummed for amd64 + arm64, on the
  private loopback port 17445. The box HTTP gateway owns loopback 7445,
  preserves dufs `/workspace` + HOME WebDAV, and adds `/ports` plus
  `/preview/<port>/`. Last-write-wins remains accepted for WebDAV.
- Ports: sshd 22, published. ttyd 7443 + ACP 7444 + files 7445, loopback only.
  Standalone reaches them through the SSH tunnel. Hosted publishes them on the
  WG interface (closed bootstrap). `EXPOSE` is documentation, not publication.
- Install = docs only (founder, 2026-08-11). No launcher CLI. No script.
  - The README holds the exact commands.
  - run: one `docker run` line. It names the digest, the state volume, the
    `/workspace` bind mount, one public key read-only, and the loopback SSH
    port. Never mount a private key.
  - First run: `docker logs -f` shows the device-flow URI + code.
  - stop: `docker stop`. It never deletes state or signals a control plane.
  - Upgrade: pull the new digest, `docker rm`, run again. The volume survives.
  - The current digest lives in the README + release notes, per release.
  - The docs show the host-key fingerprint check and the tunnel command.
  - Add a ~100-line POSIX script later, only if real users fumble the docs.
    Never curl|sh.
  - Mac docs: Colima (decided 2026-08-11). Free, OSS. Other docker-compatible
    runtimes work, undocumented.
- Enrollment: `blitz-cred enroll` (2026-08-11) — the shared device-flow client
  from the broker Go module; no image-init script. First start, one-shot.
  Generate the keypair atomically if absent. Run device authorization with the
  pubkey. Print only the URI + user code. Persist the binding 0600. Reuse it
  forever. Idempotent across interrupt and retry (Lane 1 FIX). Skipped when a
  credential already exists (hosted: phone_home delivered it) or no CP is
  configured.
- Proof on later CP calls (decided 2026-08-11): the device-flow OAuth tokens.
  Short-lived access + rotating refresh. Opaque, hashed rows, constant-time
  compare. No mTLS, no request signing. The keypair serves the SSH surfaces.
  `blitz-cred register` authenticates with this token (2026-08-11 record fix).
- Docker in the box (decided 2026-08-11): DinD. The image ships an inner
  dockerd; the container runs privileged. Isolation boundary = the
  single-tenant VM (hosted) or the user's machine (BYOM), as before.

## Closed (hosted fleet integration only)

- Hetzner bake/snapshot/promotion/rollback + fleet lifecycle (OPS.md flow).
- Hosted VM bootstrap, thinned to: container substrate; mount the provisioned
  raw volume; pull the exact open digest; firewall/metadata boundary BEFORE any
  reachable service (hard prerequisite, Lane 5 FIX); one-shot readiness — the
  phone_home response returns the box credential, written 0600 onto the state
  volume (2026-08-11); start the container already enrolled.
- Golden = thin snapshot (decided 2026-08-11): container runtime + the open
  image pre-pulled by digest. A thin bake pipeline survives. Same open digest
  everywhere. No second native box payload survives.
- Closed ingress provisioning/authz/route sync. Hosted GitHub OAuth/App
  minting.

## Deleted (decision in parens)

- Both native installers + tarball + curl|sh + `/install` static assets
  (OCI image).
- The whole `blitz` launcher CLI, incl. login/host/offline/update, browser
  loopback token, profiles (install = docs only; enrollment = device flow).
- Heartbeats, availability offers, lease pickup/hold/release/handoff,
  `SelfProvider` coupling, dual-use bearer, `/cli-auth` (heartbeat + BYOM +
  bearer deletions).
- `blitz-activity-report`, `blitz-exec` + job/result files (ssh does this
  work).
- `blitz-volume-attach`/`-backup`, restic excludes, tmux-resurrect park
  coupling, Home materialization (drives/restic dead).
- Box-side Caddy and direct ingress to arbitrary app ports. Preview and port
  discovery now share the files HTTP surface through the static box gateway;
  no extra listener, SSH forward, or hosted ingress route is added.
- Private `/chat` protocol, layout REST, marker files, client-asserted
  attribution, handoff synthesis, Codex SDK translation + rollout parsing +
  fallback catalogs + fabricated diffs (ACP + official App Server).
- opencode/kimi/pi/prime install + restart machinery (pull-class Claude +
  Codex only).
- Box-side WireGuard config tied to closed ingress. Standalone = SSH tunnel.
  Hosted WG lives on the host VM.
- `blitz-git-credential`, with no replacement (decided 2026-08-11). Git auth
  is caller-owned: `ssh -A`, `scp` a key, or pipe `gh auth token`. Docs show
  the pattern.

## Standalone connectivity (no closed ingress)

- OSS v1 = SSH forwarding only. Publish key-only 22. ttyd/ACP/files stay
  loopback. The cockpit/orchestrator owns
  `ssh -N -L 7443:… -L 7444:… -L 7445:…` and the pinned host key.
- Browser on another device, no tunnel there: the user brings their own edge.
  Decided 2026-08-11: this is docs, not an open ingress package. The open docs
  ship a reference recipe: one Caddyfile (host label → box:port, wildcard TLS,
  WS), or `tailscale serve` per box. It plugs into the cockpit endpoint
  resolver. Our ingress stays closed. Its custom parts (WG mesh, syncd on the
  closed map feed, forward_auth) do not run in a self-host world.

## FIX carried into the rewrite

13 items. file:line + red-first tests are in the full report.

- Pin everything: base digest, packages, ttyd checksum, npm lock, ACP SDK,
  agent CLIs, s6, `blitz-cred` module revision. A mutation must turn
  publication red.
- Actor input hygiene: payload cap, schema validation. A malformed frame
  closes only that connection. This kills the null-frame crash class.
- Bounded queues everywhere: prompt ingress, journal replay window,
  per-subscriber buffers. A slow subscriber disconnects alone.
- Browser Origin gate on ttyd/ACP. An SSH tunnel does not stop a hostile
  localhost webpage. dufs has no stock Origin allowlist; the files surface
  accepts that limitation rather than adding a proxy.
- One engine per session (actor map). Turn FIFO. Identical seq stream to N
  subscribers. Socket close ≠ cancel. A resume failure never re-runs a prompt.
- Async per-turn Claude mint + resume. This kills the 1 h expiry and the 20 s
  sync freeze.
- Idempotent enrollment. Host key stable across stop/run. Wrong key rejected.
- No secret in `docker inspect`, argv, logs, or image layers (sentinel test).
- Gate image publication on unit + ACP conformance suites: request IDs,
  cancel, terminal convergence, replay, N subscribers, malformed frames,
  Origin, caps, both providers. Syntax checks alone published broken bridges
  before.

## Decided 2026-08-11 (was open questions)

1. ACP transport: WS listener on 7444, pinned to the published draft
   remote-transport profile and its conformance fixtures. Adopt the stable
   profile when it lands.
2. Identity proof: the simplest stock path. The device flow already issues
   OAuth tokens. Use them: short-lived access + rotating refresh, opaque,
   hashed rows, constant-time compare — the pattern the CP already uses for
   sessions. No mTLS. No DPoP. No request signing. The keypair serves the SSH
   surfaces (broker mint/deposit).
3. Golden: thin snapshot. Bake = container runtime + the open image
   pre-pulled by digest. Boot ≈ 1 min. Clean-base-and-pull adds ~1–1.5 min
   (docker install + 1–2 GB pull) and puts the registry in the boot path.
   A thin bake pipeline survives. Same open digest everywhere.
4. Mac substrate: Colima (free, OSS). Documented and tested. Other
   docker-compatible runtimes work, undocumented. Locked 2026-08-11: the
   fresh-Mac cost (~5 min, once per machine: brew install + first
   `colima start` + pull) is accepted. Docs say install Colima first. Rented
   macs (EC2 Mac) wait the same ~5 min once.
5. Docker in the box: DinD. The container runs privileged with an inner
   dockerd. Docker exists to unify install, not to add isolation. The
   isolation boundary stays what it was before containers: the single-tenant
   VM (hosted) or the user's own machine (BYOM).
6. GitHub credentials: no helper. Git auth is caller-owned. From a Mac or any
   workspace that already holds the key, the agent moves access itself:
   `ssh -A` agent forwarding (the key never leaves the source machine), or
   `scp` a key, or pipe `gh auth token` over ssh. The docs show the pattern.
   Prefer per-repo deploy keys over copying a main identity.
7. Second pass, cross-package synthesis (2026-08-11): the box runs with no
   control plane (enroll/register/watch skipped; HOME credentials) · hosted
   enrollment = the phone_home response delivers the credential, no human ·
   enrollment code = `blitz-cred enroll`, shared with the broker image · the
   ACP conformance fixtures live in the shared `schema` package and also
   drive the ui reducer tests, one pinned ACP SDK version for both. Front
   door: `packages/oss/README.md`.

## Resolved

- Files/preview gap: FOUR external surfaces. dufs 0.46.0 retains accepted
  last-write-wins behavior behind the 7445 box gateway, which also provides
  port discovery and WebSocket-capable preview routing (2026-08-14). Hosted
  attach needs no new ingress: the closed bootstrap already publishes
  7443/7444/7445 on the WG interface and ingress Caddy routes to them.
- Browser access for OSS users (2026-08-11): tunnel on the same machine, or
  the user's own edge from the docs recipe. No open ingress package.
- Launcher (was open q 7, 2026-08-11): none. Install is docs only. The box is
  the image; the CLI held no logic. Multiple instances = the user names
  containers/volumes; the docs show the pattern. A small script comes later
  only if the docs prove error-prone.
