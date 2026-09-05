# Thin-image payload lab

These scripts implement the E1–E16 experiment table in
`plans/THIN-IMAGE.md` §6. They publish disposable payload variants, move the
self-hosted thinlab deployment pin, and inspect real Hetzner workspaces.
They never create or delete a workspace.

Required for a real run:

- `THINLAB_TOKEN`: a box/machine-plane bearer (`blitz-cred api-token`).
- `THINLAB_COOKIE`: a workspace-admin `blitz_session` cookie value. Session
  credentials are accepted only in this cookie, never as bearer tokens;
  payload-hold writes need this form. When set, it takes precedence over
  `THINLAB_TOKEN` for control-plane calls.
- `THINLAB_PROXY_TOKEN`: a read-only operator bearer for experiments such as
  E6 that measure through the control-plane webapp proxy. E2 probes the
  gateway and opens its terminal WebSocket locally over box SSH, so it needs
  no browser ticket or proxy token.
- `LAB_SSH_KEY`: the private key installed when the lab machines were
  provisioned. `box_ssh` uses the workspace view's host/port/user. It does not
  grant VM-host access. No experiment depends on host SSH, the Docker socket,
  or a forced updater process.
- `LAB_DEPLOY_REPO`: the dedicated deploy checkout with a deployable
  `packages/control-plane/wrangler.toml` for `blitz-thinlab`, plus the
  Cloudflare credentials used by the existing publisher and deploy scripts.
  Live runs refuse to fall back to the experiment checkout.
- `LAB_DAEMON_ARCHIVE`: a daemon archive built by
  `build-box-daemon.mjs`; E3, E4, and E7 use its executable bytes without
  rebuilding Docker. Each daemon experiment re-stamps a temporary copy with a
  `+lab.<serial>` suffix derived from the experiment marker, producing a real
  daemon version and archive-digest change rather than republishing the base
  payload.
- `HETZNER_API_TOKEN`: only E7, for the provider-level reset action.
- `LAB_OLD_CP_ORIGIN`: only E15. The harness and supplied workspace must
  already be attached to this old/no-payload-field deployment; the harness
  never rewrites the box's root-owned origin. E15 prints `SKIP` when that
  deployment is unavailable.
- `LAB_401_ORIGIN` and `LAB_5XX_ORIGIN`: only E9. They are fixture origins
  that consistently answer those classes without logging request headers.
  E9 pins their manifest URLs while keeping the box's real control-plane
  origin intact.

`LAB_WORKSPACES` is a whitespace-separated list consumed by `run-all.sh`.
Each E script also accepts `<workspace-id> [machine-id]`. E14 requires two live
member machines in its workspace and prints `SKIP` when only one exists.
E1-E4 start and track their own Claude turn
through `session-driver/drive.mjs`. E1 and E2 hold that exact turn at its own
permission request until the payload assertion is complete, then allow it and
require its completion marker. E4 holds its turn only until the updater reports
the daemon-changing release as `deferred`, then allows a `sleep 60` command and
asserts that neither half switches while it runs; the idle tick after completion
must apply both halves while preserving the completed session. Their default
prompts use a harmless, self-removing file under `/tmp` so Manual mode reliably
requests permission before the experiment releases its turn. E2 also creates one
uniquely named tmux session, puts its pane in the same `user/tab-*` cgroup placement as
`blitz-term`, and removes only that session on exit. If the box image cannot
create the unprivileged cgroup leaf, E2 records and uses the permitted plain
tmux fallback. Existing sessions and tabs are never treated as preconditions,
compared as a whole, or cancelled.

The production publisher has no test-only overlay flag. `publish_variant`
therefore clones the current checkout into a temporary directory, copies one
mutated file from an overlay directory into that clone, and invokes
that clone's `publish-box-payload.mjs --repo <clone>` so imported release
metadata and staged sources come from the same commit. The dedicated deploy
repo's uncommitted `wrangler.toml` is copied in only for the R2 upload. E5 and
E12 then overwrite one versioned test object to make failures that a validating
publisher correctly refuses to emit.

Pinning changes only the payload. Before every deploy, `pin_payload` reads the
deployment's public `/version` report and compares its `boxImageRef` and
`boxImageTag` with the values in the lab's `wrangler.toml`; it also requires
that config's worker name, `APP_URL`, and R2 binding to identify thinlab. It
refuses the deploy if they differ. A lab that intentionally keeps its image pins outside
that file may instead set all of `LAB_IMAGE_REF`, `LAB_IMAGE_TAG`, and
`LAB_IMAGE_SHA256`; the helper checks the reported ref/tag and passes all three
through to the deploy. It never sends only the two payload vars when doing so.
Every pin runs from `LAB_DEPLOY_REPO`; the experiment checkout's generated or
missing config is never a deploy input.

No experiment forces an updater transaction. After a pin, every experiment
waits for the box's supervised payload service, whose default poll interval is
five minutes. Failure attribution comes from the world-readable
`/opt/blitz/payload/state/log` and `state.json`; a failure result's version names
what remains running, while `state.failed.version` and the log name the
attempted target. `LAB_OUTCOME_TIMEOUT` therefore defaults to 420 seconds.
E8 likewise waits for the host image updater's normal timer after requesting
`blitz box update`; `LAB_IMAGE_UPDATE_TIMEOUT` defaults to 420 seconds.
Session waits pass
`--timeout "$LAB_TURN_TIMEOUT"` to the driver; that value defaults to 900
seconds. E4 uses separate windows to observe the scheduled deferred report and
the first idle tick after its 60-second turn. The loop's first tick starts five
seconds after boot.

Useful tuning variables are `LAB_OUTCOME_TIMEOUT`, `LAB_PAYLOAD_INTERVAL`,
`LAB_TURN_TIMEOUT`, `LAB_TURN_AGENT`, `LAB_TURN_PROJECT`, `LAB_E1_PROMPT`,
`LAB_E2_PROMPT`, `LAB_E3_PROMPT`, `LAB_E4_PROMPT`, their matching
`LAB_E*_EXPECTED_TEXT` values, `LAB_E13_COMMAND`, and `LAB_HEALTH_PATH`.
Experiments that use the control-plane proxy default `LAB_HEALTH_PATH` to
`/healthz`; changing it to `/diag` is useful only while bringing up a
deployment that has not exposed the specified health path.
`LAB_PAYLOAD_INTERVAL` is the live box's configured updater interval and
defaults to the design's 300 seconds; E4 allows that interval plus restart
slack after the turn becomes idle. The forced four-hour cap is covered by the
real-script guest test because the live box's
`BLITZ_PAYLOAD_DAEMON_IDLE_WAIT` cannot be changed by this harness.

The headless driver uses one persistent SSH stream-local forward to the box's
existing Lody bridge. `open` prints the daemon's local user, workspace, and
machine ids. The session commands boot the same web runtime and seed the same
agent-config rows as the browser. Progress goes to stderr; `create` and
`prompt` print only the session id, while `status` and `wait` print JSON. State
is kept in a mode-0700 directory under `/tmp`, never in the operator's HOME.
The driver records which sessions it created and will answer permission
requests only for those sessions. `create` and `prompt` accept `--permissions
allow|deny|ask` (default `allow`); `wait` applies the recorded policy, returning
`awaitingPermission` immediately for `ask` rather than consuming the timeout.
For Claude, `ask` also puts the turn in the daemon's `default` (Manual) mode;
leaving its mode absent would select `auto`, whose classifier can consume the
request before the driver sees it.
`session permissions <id> <mode>` changes that recorded policy for the next
`wait`, which lets an experiment release only the turn it created.

```sh
driver=packages/box/test/payload-lab/session-driver/drive.mjs
node "$driver" open --ssh blitz@box.example:22 --key /path/to/id_ed25519
session=$(node "$driver" session create --agent claude --prompt 'say hi' --permissions allow)
node "$driver" session status "$session"
node "$driver" session permissions "$session" allow
node "$driver" session prompt "$session" 'now summarize the workspace'
node "$driver" session wait "$session" --timeout 900
node "$driver" session list
node "$driver" session cancel "$session"
```

Dry-run every experiment without credentials or network access:

```sh
PAYLOAD_LAB_DRY=1 packages/box/test/payload-lab/run-all.sh
```

Real three-run matrix:

```sh
LAB_WORKSPACES='workspace-one workspace-two' \
  packages/box/test/payload-lab/run-all.sh
```
