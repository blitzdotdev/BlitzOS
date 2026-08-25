# oss/broker — credential broker (daemon + client), open

Founder constraints (ratified 2026-08-11):

- broker self-host option with documentation
    - make zero assumptions about the host it is running on (no Hetzner, hcloud etc that is users' responsibility)
- just install the broker via docker pull, define control plane base urls, and setup broker CLI thats it

Carve 2026-08-11. Full report: session scratchpad `codex-broker-carve.txt`.
Registry half: `packages/oss/control-plane/TODO.md`. The daemon is OPEN.
Inventory: 32 files, ~5.2k LOC → 24 open, 7 closed, 1 deleted.
No open questions remain. All were decided 2026-08-11 (see Decided).

## In core (open)

These mechanisms carry into the rewrite:

- The Go daemon.
  - Stock OpenSSH forced-command auth. One key = one operation. The caller never
    picks mint/deposit/harness.
  - Root sync process. Unprivileged mint/deposit processes.
  - Authoritative reconciliation. Member present with empty keys = keep the
    account. Member absent = deprovision.
  - One exclusive per-member lock. The "N mints, one refresh" proof carries.
  - Atomic write chain. No custom OAuth client. No second token cache. Vendor
    CLIs own refresh. (`credential.go`, `mint.go`, `deposit.go`, `sync.go`,
    `lock.go`, `atomic.go`, `vendor.go` + tests.)
- Deposit contract: stdin, staged HOME, vendor verification before replacement,
  one exact `ok\n` ACK. Nothing else. No event log (see Deleted).
- The Docker runtime: Dockerfile + entrypoint. Persistent users, homes, config,
  host keys on ONE state volume. Shares the base layer + state-volume pattern
  with the box image (2026-08-11). README becomes the self-host guide.
- Vendor adapters: Claude + Codex. They hold command names and credential
  layouts. Nothing proprietary. The daemon hands them the only refresh-token
  copy, so they must be open to audit.
- Workspace-side client, moved out of the golden image into this module. The box
  OCI image consumes it. The watcher reads refresh-token files, so the trust
  rule keeps it open. The chat bridge is already open (2026-07-28 split).
- Wire contract: opaque `version`, strict decode, 1 MiB cap, member-absent =
  deprovision. All carry. No ceiling: `expires_at` leaves the schema, the wire,
  and the authorized_keys render.

## Closed (hosted fleet ops only)

- Broker fleet lifecycle: provisioning, rollout, monitoring, replacement,
  capacity.
- The D1/wrangler registration wrapper. Native Debian/systemd convergence and
  verify scripts. `package.json` monorepo glue.
- The hosted principal adapter (memberships/orgs) and placement/cap policy.
- No credential-custody code is closed-exclusive.

## Deleted (decision in parens)

- Heartbeat expiry: `BROKER_KEY_GRACE_MS`, `WORKSPACE_ALIVE_AT`, lease join,
  `live_at` version leg, the `Math.min(alive_at+grace, …)` render (heartbeat
  dead).
- Restart-class machinery, end to end: `RESTART_CLASS_HARNESSES`,
  `isInteractiveWorkspace`, opencode + kimi integrations, the watcher
  restart/rewrite loop and its invented 4-hour validity (core = pull-class only).
- Dual-use box bearer on registration → the box OAuth token (2026-08-11).
  Rule: HTTP plane = tokens; SSH plane = keypairs. The keypair never
  authenticates an HTTP call.
- `adopt`/`adopt_pubkey` compatibility shims (fresh schema, fresh client).
- The redundant systemd timer (the daemon already polls at 1 s).
- The restic `backup-exclude.harness-credentials` coupling (drives/restic dead).
  The client keeps its own credential-path list for deposits.
- The cross-account deposit event/log (founder, 2026-08-11). No log when a user
  deposits a different vendor account. The token works or it does not. Deposit =
  verify + store + ACK. This also removes the custody-changed-before-event
  failure mode.

## Security consequence to hold

No ceiling (founder, 2026-08-11). Do not control key lifecycle.

- A key is valid exactly while the feed serves it.
- Registry reachable: destroy revokes in ~1 poll (CASCADE).
- Registry unreachable: the last rendered keys stay valid until the next
  successful sync. Revocation IS the feed.

## Self-host install story (decided 2026-08-11)

- Publish the image. CI builds and pushes to a public registry, digest-pinned.
  The Dockerfile exists. Publishing is the missing task.
- One `enroll` command, run INSIDE the container
  (`docker exec broker … enroll --origin <url>`). It runs the same device flow
  as the box (2026-08-11: one token family; the separate pull token is
  deleted). It reads the container's own SSH host pubkey, registers
  host/port/pubkey through the enrollment API, and writes the 0600 credential
  config onto the state volume. This one command replaces the wrangler D1
  insert, the hand-seeded config file, and the host-key extraction.
- The config file exists only to hold the box credential. Secrets never go in
  argv or env (env shows in `docker inspect`). The CLI writes the file. Nobody
  hand-writes it.
- The enrollment API lives in core (`packages/oss/control-plane/TODO.md`).
- The daemon advertises exactly what the image installs: Claude Code + Codex.

## The CLI: two binaries, one Go module

Decided 2026-08-11. Shared internal packages. The two are never co-installed:
one ships in the broker image, one in the box OCI image. No image carries the
other's code. Custody code never enters the workspace box. Each image pins
independently. This absorbs ~600 lines of box-side shell
(`blitz-broker-register`, `blitz-cred-watch`, `blitz-cred`, `blitz-cred-codex`)
and the systemd wiring.

`blitz-broker` — broker box (inside the broker container):

| Command | Invoked by | Job |
|---|---|---|
| `enroll` | operator, once | device flow → box credential; register own SSH host pubkey + host/port → write 0600 config on the state volume |
| `sync` | entrypoint (daemon loop) | poll the feed, reconcile unix users + authorized_keys |
| `mint <harness>` | sshd forced command only | refresh via vendor CLI when needed, print short-lived token |
| `deposit` | sshd forced command only | stdin blob → staged HOME → vendor verify → atomic replace → `ok` |

`blitz-cred` — workspace box (installed in the box OCI image):

| Command | Invoked by | Job |
|---|---|---|
| `enroll` | box first start, one-shot | device flow → box credential, 0600 on the state volume. Skipped: no CP config, or hosted already delivered it via phone_home |
| `register` | box boot, idempotent | generate mint/deposit keypairs, register pubkeys (auth = the box OAuth token), write pinned broker config + harness hooks |
| `token <harness>` | harness hooks (codex `auth command`, session-actor turn refresh) | ssh mint over the pinned host, print token |
| `watch` | box service, interactive workspaces | detect a fresh vendor login, deposit it |

`mint` and `deposit` are never typed by a human. They exist only as `command=`
targets in authorized_keys. Both `enroll` commands call ONE device-flow client
package inside the module (2026-08-11).

## Decided (founder, 2026-08-11)

- Harnesses v1: Claude Code + Codex only. pi / opencode later. opencode also
  needs the restart-class problem solved first.
- No key ceiling. See Security consequence.
- One control plane per broker instance.
- Broker SSH port: configurable (host + port in registry and client). Default 22.
  Docker port mapping works.
- Second pass, cross-package synthesis (2026-08-11): pull token deleted — the
  broker box enrolls through the same device flow and the feed accepts the box
  OAuth token · `blitz-cred` gains `enroll` · one shared device-flow client ·
  the broker image shares the base layer with the box image. Front door:
  `packages/oss/README.md`.

## FIX for the rewrite

Law #9: these stop at a PR. Red-first negative tests are in the full report.

- CRITICAL `sync.go:103`: root chowns `authorized_keys` to the member. A vendor
  process running as the member can replace it with an unrestricted key between
  polls. A `.ssh` symlink makes root write through an attacker path. Fix:
  root-owned `AuthorizedKeysFile` location.
- HIGH `broker.ts:258` vs `keys.go:27`: harness-regex mismatch. One workspace
  can poison the whole box feed past the 1 MiB cap.
- HIGH `broker.ts:443`: registration is delete/delete/insert/insert. Not atomic.
- HIGH `blitz-cred-watch:179`: ACK/unlink inode race. A fresher login can be
  deleted.
- HIGH: lock-wait vs client timeout mismatch (75 s vs 60/20 s). A disconnect can
  kill a mid-rewrite of the only credential.
- HIGH `members.ts:183`: a disabled member never leaves the feed. The credential
  home persists.
- HIGH `sync.go:138`: `userdel` runs without proof that the member's processes
  are dead. UID reuse exposes the next member's files.
- HIGH `blitz-broker-register:198`: `broker.env` shell-interpolation escape.
- HIGH `client.go:58`: the error path logs up to 4 KiB of registry response.
  Token echo risk.
- HIGH `config.go:43`: no HTTPS requirement on the configured origin.
- HIGH `broker.ts:370`: member_cap check and insert race.
- MEDIUM: unpinned base image/apt/npm in the Dockerfile. Root pubkey login
  permitted in container sshd. Keypair reuse checked by size only. Dry-run
  leaves a raw token in `/tmp` (closed path).

## Deferred: harness authentication status

Do not add broker-backed Claude or Codex status reporting as part of the
WebApp authentication gate. Standalone boxes can ask the pinned vendor CLIs
directly; broker-enrolled boxes should report `unknown` until this contract is
designed and tested independently.

Before adding a broker status command:

- Define whether `signed-in` means only that credential material is present,
  or that it is currently usable. The UI needs the latter.
- Treat expired credentials and credentials that cannot refresh as signed out;
  a parseable access token alone is insufficient.
- Keep the status response secret-free. It must never print a token, refresh a
  credential as a side effect, or interfere with an in-flight turn.
- Add direct server tests for the complete forced-command SSH path, including
  `SSH_ORIGINAL_COMMAND`, allowlist enforcement, malformed commands, and both
  supported providers.
- Document the compatibility window and deployment order across broker,
  `blitz-cred`, box image, actor, and WebApp versions.
- Prove the final protocol against a real broker container and a newly built
  box image before enabling it in the UI.
