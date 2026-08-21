# e2e deficiencies & gaps log

## MICROVM FEATURE + FINALE (2026-08-13, feat/microvm)

- **MicroVM workspaces live through the deployed control plane: gate 9/9, create→ready 1279–1414 ms** (target <5000). Spike: 739 ms boot; agent API p50 1.06 s. Stress: 108+ lifecycles, unloaded p95 1.49 s, loaded (8 cores + 4 GB stress-ng) p95 1.81 s, 40-cycle churn p95 1.36 s, 10-min endurance 54/54 webApp checks, zero leaks throughout. 10 concurrent ready together (1.06 s); 11th create cleanly rejected (principal quota 409). Host: minjune-650S via host agent (systemd) + cloudflared tunnel (ephemeral — durable tunnel is a follow-up).
- **Volume reattach FIXED and live-proven (nonce match)**: three-bug arc — (1) credential contract drift (fixed both sides), (2) filesystem-unsafe detach (graceful shutdown; marker survives), (3) stale box identity on reattach (destroy deletes the box record; bootstrap now clears stale credential/origin; proven by read-only volume forensics of the durable bootstrap.log).
- Bootstrap failures now surface as phase=error with the message (live-proven); bootstrap log persists on the volume.
- New agent capacity model: cpu_overcommit (default 1.0; lab 2.0) with physical+effective reporting.
- Follow-ups: durable tunnel (named/tailscale) for the agent API; machine-types catalog listed cx23 absent while creatable once (reconcile listing vs create validation); s7 probe wall time ~10 s is test-side tunnel setup, not product.
- Durable image-side follow-up: `blitz-cred watch` should retry `register` when phone-home installs credentials and origin after the image's register one-shot; the substrate bootstrap pokes are recovery bridges, not the long-term home.
- Broker + microVM verdict: transport, assignment, forced-command auth all work across the boundary; auto-provisioning live-proven post-fix (zero manual registers). Full mint/deposit needs a real vendor OAuth credential on the broker (correctly refused without one). [F] `blitz-cred token` maps all broker failures to a generic "broker SSH request failed" — surface broker stderr for diagnosability.

Customer-POV self-host test of blitz-core on a real Cloudflare account + real Hetzner project.
Started 2026-08-12. Living document — updated as e2e runs land.
Severity: **[B]** release blocker · **[F]** friction · **[D]** doc bug · **[ext]** external/provider · **OK** verified working.

## What the e2e proved works (on real accounts)

- Control plane deploys to CF Workers + D1 with wrangler; migration applies; secrets flow.
- Full workspace lifecycle via API **and** via webApp ui: login → create → Hetzner VM boots → cloud-init `phone_home` → `ready` → strict-hostkey ssh → destroy (tombstone).
- Box image builds natively on arm64 (114 s) and under amd64 emulation (60 s).
- Local box (README path 1): all four webApp endpoints live — sshd, ttyd :7443, ACP actor :7444 (WS 101), dufs :7445; host-key fingerprints match.
- WebApp tabs after fixes: Terminal renders xterm via ttyd; Files lists `/workspace/`; ACP Chat connects.
- Teardown discipline: every e2e workspace verifiably destroyed; no orphan VMs.
- **Box-on-Hetzner proof (manual bridge)**: amd64 image on a `cx23@fsn1` VM under the deployed control plane — all three webApp endpoints answered from the laptop through a strict-hostkey double tunnel: ttyd **200**, ACP WS **101**, dufs **200**. Create→verified ≈ 6.8 min, of which 4 min was the 640 MB image upload (2.63 MB/s using four parallel ssh streams; single-stream attempts timed out at 600 s and 1800 s). Inner dockerd came up; s6 graph healthy.

## RELEASE GATE: 9/9 GREEN (2026-08-13)

`e2e/selfhost.mjs` full pass on real CF + Hetzner: login, machine-types, keypair, create, ready (~2.5 min), box ssh (port 22, strict hostkey), webApp endpoints via tunnel (ttyd 200, dufs 200, ACP WS 101), credentials on disk via phone-home, destroy verified by label query. Zero leaks. Three harness bugs fixed en route (in-box curl assumption; tunnel arg order + fixed-sleep race; ws-101 curl-exit pedantry).

## Bootstrap arc (2026-08-12/13, three runs)

- Run 1 (pre-bootstrap): false `ready` on empty Ubuntu; webApp endpoints dead; no credentials.
- Run 2 (bootstrap v1): stuck `creating`; both ssh ports refused. Root cause, proven on an instrumented VM: on ubuntu-24.04, `/run/sshd` only exists after `ssh.service` starts; validating with `sshd -t` after stopping `ssh.socket` exits 255 and `set -e` kills the bootstrap with ssh already down.
- Run 3 (fix deployed): **product loop closed** — create → real box → `ready` in 130.6 s (docker 9 s; image download+load ≈58 s from the worker's R2 route; health ≈4 s; phone-home instant) → box ssh on 22, admin on 2222 → **credentials on disk (0600)** → destroy verified by label query. 7/9 only because the harness probed with in-box `curl` (image has none; services proven listening) and destroy used a stale session after diagnostic pauses.
- New friction: bootstrap log lacks timestamped phase markers; cloud-init reports `degraded done` from benign warnings; `e2e/selfhost.mjs` default machine type was still deprecated cx22 (now cx23).

## Open release blockers (product)

1. **[B] The fleet path never installs the box.** Generated cloud-init only creates the `blitz` user + phone_home. No Docker install, no image pull/run, no state volume, no `/workspace`. Customers get a plain Ubuntu VM that reports `ready`.
2. **[B] Enrollment credentials are discarded.** `phone_home` response carries `box_id`/tokens, but cloud-init drops response bodies. Nothing writes `/var/lib/blitz/origin` or `box-credential.json` (mode 0600). Automated enrollment does not exist end-to-end. *Proven on-VM 2026-08-12: box running on Hetzner, both files absent.*
3. **[B] Box images are not distributable.** ghcr `blitz-box`/`blitz-broker` are private (anon 403/401); no public release notes with digests; READMEs point at placeholders. Bridge reality: 640 MB gzip streamed over ssh. Needs registry + immutable digest + arch-aware pulls (arm64 AND amd64).
4. **[B] Two ssh servers want port 22.** Workspace `ssh.hostPublicKey` is the Ubuntu host key; the box generates its own host key and also targets 22. Design conflict for the productized path.
5. **[B] Attached volume never becomes `/var/lib/blitz`.** "State survives destroy" is not realized on the fleet path.
6. **[B] ttyd `--check-origin` rejects any non-ttyd origin.** Fixed in the ui for tunnel mode (load from ttyd's own origin), but any hosted-ingress webApp origin will be rejected; must be solved in box/ingress design.
7. **[B] dufs 0.46 sends no CORS headers** (and no Origin allowlist). Cross-origin WebDAV is impossible; ui works around it via iframe embedding. Hosted mode needs a real answer.
8. **[B] Separate-origin ui is broken by design today**: control plane has no CORS/OPTIONS, cookie is `SameSite=Strict`. README's `VITE_CONTROL_PLANE_URL` promise fails as written.
9. **[B] No production ui serving story.** Repo ships no static server, Worker assets, or reverse-proxy config for same-origin mode (dev proxy added during this run is dev-only).
10. **[B] Sessions never expire** and have no cleanup janitor.
11. **[B] No capacity fallback.** Hetzner ARM (cax*) had zero placement globally during the run; customers see only per-create errors. Needs offered-type filtering by real availability and/or fallback guidance.
12. **[B] Ops hygiene: no dedicated-project guidance and no server labels.** Test workspaces shared the Hetzner project with real `blitz-v2-*` infra; janitors matching by name prefix would be catastrophic. Docs must demand a dedicated Hetzner project; servers need purpose labels.
13. **[B→fixed+deployed 2026-08-13] Conflation UX:** tabs now display their real endpoint target (`host:port`), default to an explicit "Not connected" state, never auto-select, and destroyed workspaces are hidden. Playwright-verified live (27 destroyed rows → 0 visible).

## Fixed during this run (uncommitted in the working tree)

- npm 11.19 default allowScripts blocked native install scripts → explicit approvals in root `package.json`.
- Lockfile was platform-incomplete (no darwin-arm64 TypeScript binary) → resynced.
- `@blitzos/schema` exported unbuilt `dist/` → exports point at `src`.
- `jsdom` unreachable from hoisted vitest → moved to root. `engines` added.
- control-plane: deprecated Hetzner types filtered from `/machine-types` (+3 regression tests); provider error causes surfaced (`provider operation failed: <cause>`). Deployed + live-verified.
- ui: unbound-fetch WebDAV crash; ttyd origin/subprotocol/init-frame handling; dufs iframe fallback (+regression tests). Live-verified in Chromium.
- ui dev proxy for same-origin mode (dev-only convenience).

## Friction / doc bugs

- [D] Root README links `box/README.md` etc.; real paths live under `packages/`. Root + schema READMEs say "pre-build" while code is landed. "Four-call API" claims an ssh call; only create/poll/destroy routes exist (ssh is metadata).
- [F] No prerequisite list (node/npm range, wrangler, docker/colima); `wrangler` assumed installed.
- [F] Manual D1 UUID copy into wrangler.toml; secrets not declared in wrangler config (no presence validation); `.env` name `HETZNER_API_KEY` vs worker secret `HETZNER_API_TOKEN`.
- [F] `wrangler d1 list` unusable without `--json` at scale.
- [F] Hetzner error text uses numeric type ids (104) not names (cx22).
- [F] smoke.sh: stages under macOS `$TMPDIR` (not shared by default Colima) → docker short `-v` silently bind-mounts a daemon-side empty dir; use `--mount type=bind` (loud failure) + shared paths. Rebuilds the image it should reuse. Deletes all evidence on failure; generic "not ready" masks the failing s6 oneshot.
- [F] `DOCKER_HOST` override breaks the colima context silently; README lacks `unset DOCKER_HOST`.
- [F] Rail accumulates destroyed workspaces and auto-selects a destroyed row after login; noisy pre-login 401 probe; transient 502 after login once.
- [F] Colima disk pressure: image builds exhausted storage until unused images were pruned.
- [F] machine-type count fluctuates between calls (raw pass-through, no caching/stability).
- [F] `cloud-init status --wait` exits 2 even when it prints `status: done` (ubuntu-24.04); scripts must not trust the exit code alone.
- [F] VM-ready latency varies 46–71 s run to run; the ui shows only "creating" with no sub-state.

## Coverage e2e findings (2026-08-13, e2e/coverage.mjs)

- [B] Volume-backed box reboot fails: phone-home response persisted verbatim; `blitz-cred` strictly rejects `token_type`/`expires_in` → register fails, box health timeout, workspace hangs. (Being fixed.)
- [B] Volume detach is not filesystem-safe: destroy detaches a mounted ext4 without sync/unmount; an acknowledged marker write was lost. (Being fixed: graceful shutdown before delete.)
- [B] Bootstrap failure not propagated: errored VM left the workspace in `creating` for the full 15-min bound; needs the phone-home error-report path. (Being fixed.)
- OK: destroy-while-creating → `destroyed` in ~300 ms, label gone in 174 ms, no error phase.
- OK: broker enrollment live end-to-end (device flow, approval, token exchange, registration, 0600 credential, deregistration).
- [F] No API to revoke a device-enrolled box identity/token family (only broker deregistration exists).
- [F] Root `npm test` still skips the broker Go suites (ci.yml runs them; local runner does not).

## Coverage gaps of the e2e itself (not yet tested)

- Broker path entirely: enroll → forced-command mint/deposit → box token refresh (`packages/broker`, Go suites exist but root `npm test` never runs them; no live broker e2e).
- phone_home → box credential delivery (blocked by product blocker #2; e2e must assert `/var/lib/blitz/box-credential.json` once implemented).
- Volumes lifecycle: create → attach → automount → data survives destroy → reattach; volume location/type constraints.
- ACP chat full agent turn (agent login inside box + prompt→response through webApp); only connect/empty-composer verified. ACP conformance fixtures: box actor replays 3 of 7 streams.
- Cron janitors (stale-create sweep, orphan destroy): never exercised against real state.
- Concurrency: multiple simultaneous workspaces per principal; create storms; rate limits.
- Failure injection: Hetzner quota exhaustion, phone_home timeout (VM that never phones), destroy-while-creating.
- Box upgrade path (digest rotation with state volume kept).
- Hosted ingress / non-tunnel access to 7443–7445 (no implementation exists to test).
- Windows/Linux customer environments (only macOS arm64 tested).

## Test-run ledger (2026-08-12)

- Worker: https://blitz-control-plane.blitzapp.workers.dev (account "Blitz Development Sandbox", `<account-id redacted>`)
- D1: `blitz-control-plane` `<database-id redacted>`, migration 0001 applied.
- Secrets set: `HETZNER_API_TOKEN`, `OPERATOR_API_KEY` (values in `.env`, gitignored).
- e2e scripts: `e2e/selfhost.mjs` (API lifecycle, 8 steps), `e2e/bridge.mjs` (box-on-VM bridge). `selfhost.mjs` has since been removed; `tools/e2e/coverage.mjs` is its successor.
- Workspaces created/destroyed this run: selfhost cx22 error-path ×2, cx23 full-pass, webApp cx23 (`ac27a559…`), bridge cax probes ×5 (placement failures), bridge cx23 full-pass (`7300f18f…`). Every id tombstone-verified `destroyed`.
- Final Hetzner audit (2026-08-12): zero e2e servers, volumes, or ssh keys remain. The project's 14 servers / 24 volumes / 3 keys all pre-date the test (v2 ingress/broker/workspace infra) and were never touched. Compute cost of the whole test: a few euro-cents.
- Cloud left deployed on purpose: Worker `blitz-control-plane` + D1 + secrets (the user's own self-host deployment).
- Local left running for development: container `blitz-box-test`, tunnels 7443/7444/7445, vite dev :5173.
