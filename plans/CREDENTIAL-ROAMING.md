# Credential roaming: log in once, every workspace stays signed in

Status: **plan.** Direction decided 2026-08-19; **revision 2 (2026-08-20): corrected against the production broker in `~/monorepov2`**, which is battle-tested on blitzos.com. Where production solved a problem, this plan adopts the production mechanism by reference instead of inventing one. The inference gateway stays **deferred** (`plans/INFERENCE-GATEWAY.md`) — it answers org-key metering only.
Grounding: recon of the blitz-core rewrite (`packages/broker` @ `feat/aws-provider`), recon of the production system (`monorepov2` paths below), and the SDK auth harness (`sdk-verify/`).

## The problem

Users of Claude Code and Codex get logged out constantly. A login lives and dies with one box; every new workspace is a fresh VM. The wanted behavior: log in once, and every box you own stays signed in.

## What production already proves (monorepov2, in prod today)

The old repo runs the full solution. Its shape, end to end:

```
BROKER BOX (operator VM; systemd timer or Docker)
  `blitz-broker sync` polls the plane 1s (ETag) → reconcile:
     useradd m-<12hex> per MEMBERSHIP, /home 0700, authorized_keys with
     expiry-time= and command="blitz-broker mint <harness>",restrict
  sshd, key-auth only. Holds THE ONLY COPY of each user's vendor credentials.

MEMBER BOX
  register (root, oneshot, NEVER fatal): keys per harness → POST broker-key
     → broker.env + pinned known_hosts; writes the codex config block;
     DELETES /etc/claude-code/managed-settings.json
  blitz-cred-watch (5s poll): credential file changed → deposit over ssh →
     on "ok" ACK → **unlink the workspace copy**. Single copy by construction.

  DELIVERY — no credential file ever comes back down for claude/codex:
     terminal claude → PATH SHIM: mint → export CLAUDE_CODE_OAUTH_TOKEN → exec pinned binary
     chat/SDK      → execFileSync(blitz-cred-claude) → options.env.CLAUDE_CODE_OAUTH_TOKEN
     codex         → config.toml [auth] command=blitz-cred-codex, refresh_interval_ms=300000
     opencode only → access-token-only file write-down; refresh token never leaves the broker
```

Production facts that override my earlier guesses:

1. **There is no "restore" verb, and there must not be one.** Terminal roaming is token-at-launch: a PATH shim mints and injects `CLAUDE_CODE_OAUTH_TOKEN` at every process start (`packages/box/golden/cloud-init.yaml:40-61`). Codex pulls its token itself every 300 s via its config `command=` hook. Only opencode gets a file write, access-token-only, with the written contract "THE REFRESH TOKEN IS NEVER TOUCHED" (`blitz-cred-watch:240-299`).
2. **Chat delivery is the env var, full stop.** `options.env.CLAUDE_CODE_OAUTH_TOKEN` (`bridge.mjs:306-317,473`). `ANTHROPIC_API_KEY` with a minted `sk-ant-oat01-…` breaks and flips a Max subscription to per-token billing; a managed `apiKeyHelper` alongside a valid token **hangs** claude (#221) — so `managed-settings.json` gets deleted, not overridden (`blitz-broker-register:208-230`). The rewrite's `getOAuthToken` path appears nowhere in production and is dead at the shipped pins.
3. **Single copy by construction.** After a verified deposit the member's copy is **unlinked** (`blitz-cred-watch:316-321`), all credential paths sit in every backup-exclude lane, and the broker is the only refresher — with a per-member `flock` held across read→trigger→re-read, `lockWait > vendorTriggerTimeout`, and a 60 s trigger timeout, all shaped by the 2026-08-07 incident where a mid-refresh kill blanked the only copy (`packages/broker/lock.go:14-63`, `vendor.go:26-41`).
4. **Identity = one unix user per membership**: `m-<12hex>` derived server-side, regex-gated on create AND delete, `UNIQUE(broker_box_id, unix_name)` (`routes/broker.ts:331-344`, `keys.go:25`, `sync.go:159-171`). The rewrite's shared `blitz` name is a pure regression and the isolation boundary of the whole design.
5. **The broker is optional and every path is non-fatal.** Zero `broker_boxes` rows = feature off. `no_broker_capacity` → the box removes stale wiring and exits 0. The watcher is `ExecCondition`-gated. Nothing `Requires=` register. Mint failure = claude runs signed-out. The rewrite's `exit 1` on 409 and watch-pauses-forever are regressions.
6. **Provisioning is deliberately manual**: two-pass runbook, printed SQL a human executes, `verify-broker-box.sh` as the gate, shared-across-orgs pool with `member_cap` 25 as blast radius (`provision-broker.sh`, `OPS.md:322-381`, migration `0023:23-25`). "No autoscaler" is a written decision, not a gap.
7. **The top real-world logout cause was vendor self-update** shadowing the shim — hence `DISABLE_AUTOUPDATER=1` in both the shim and the broker's vendor env.

## Root cause of today's logouts (blitz-core instances)

Unchanged from revision 1, now with sharper fixes: (1) no broker box exists, and the rewrite's failure handling turns that into paused services instead of graceful signed-out; (2) chat delivery uses a dead callback where prod uses the env var; (3) terminal delivery (shim + codex hook) was never ported. Plus the `unix_name` regression blocking multi-user.

## Implementation — one pass

Port production behavior into blitz-core; keep the rewrite's genuine improvements (HTTP key push instead of 1 s D1 polling; the Go watch daemon; image-based broker deploy). In dependency order:

- **Adopt verbatim from monorepov2** (paths above and in the recon): unix-name derivation + double regex gate; per-member flock with the `lockWait > vendorTriggerTimeout` invariant; deposit staging-HOME verification + never-touch-stored-on-failure; delete-workspace-copy-on-ACK; `atomicWrite` chown-before-rename; the backup-exclude file as the single source of watched paths; `DISABLE_AUTOUPDATER=1` everywhere a vendor CLI runs.
- **Delivery, claude**: the PATH shim (mint → `CLAUDE_CODE_OAUTH_TOKEN` → exec pinned binary, failure non-fatal) for terminals (the actor's `options.env` path is retired with the actor, 2026-08-29); delete `managed-settings.json` at register; delete the `getOAuthToken` branch. One cheap harness run confirms the env var at the new pins (2.1.228) before relying on it.
- **Delivery, codex**: the config-block writer with marker regions + `refresh_interval_ms` hook.
- **Resilience parity**: register retries then exits 0 with stale-wiring cleanup on `no_broker_capacity`; the s6 `watch`/`register` units become non-blocking (`ExecCondition` semantics, no hard dependency); broker stderr surfaced in `blitz-cred token`.
- **Identity**: per-membership unix names in the plane (`principals.ts:69`, `google.ts:185-187`) with migration + backfill; sequence around reconcile's `userdel --remove` so no home is deleted out from under a live member. No multi-user org touches a broker before this lands.
- **Provisioning**: port the two-pass runbook + `verify-broker-box.sh` gate to the blitz-core broker image; `member_cap`; zero-rows-means-off semantics preserved.
- **Chat `/login`**: webapp-only — drive the existing ttyd tab, reuse the sign-in scraper + `PasteCodeModal` (`TtydTerminal.tsx:181-187`, `CloudApp.tsx:1808-1823`).

## Verification — one pass, done means

- The falsifier flips on the dogfood instance: a broker row exists and `broker.env`-equivalent lands on live boxes.
- A new workspace opens chat already signed in; a raw terminal `claude` and `codex` are signed in on a second, fresh workspace. Zero logins after the first.
- Auth status is probed the production way — absolute binary path + real wire check, never the shim, never status text alone (five green-signal false positives in the prod incident log are the reason).
- Two-account isolation live: user B never sees or evicts user A's credential (per-membership homes proven).
- Kill-mid-refresh does not blank a credential (the 2026-08-07 incident class, now a test).
- A live e2e proves deposit → unlink → roam → mint → refresh across two workspaces; Go broker tests and control-plane vitest stay green.

## What this plan does NOT do

- No metering, budgets, or org key — deferred gateway territory.
- No CP custody of vendor credentials: they live on the broker box only. This is the `broker` custody direction, distinct from the connections subsystem's CP-held grants; the two stay separate on purpose.
- No broker autoscaling or self-serve broker creation — production's manual-by-decision stance carries over until a real need appears.
- No multi-user rollout before the per-membership unix-name migration lands.
