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
- `THINLAB_PROXY_TOKEN`: a read-only operator bearer for E2's
  `/webapp/7445/healthz` probe when neither `THINLAB_COOKIE` nor the
  box-plane-scoped `THINLAB_TOKEN` can proxy it.
- `LAB_SSH_KEY`: the private key installed when the lab machines were
  provisioned. `box_ssh` uses the workspace view's host/port/user. It does not
  grant VM-host SSH on port 2222. Experiments that explicitly need host access
  require a separately provisioned `LAB_HOST_SSH_KEY`.
- A deployable `packages/control-plane/wrangler.toml` for
  `blitz-thinlab`, plus the Cloudflare credentials used by the existing
  publisher and deploy scripts.
- `LAB_DAEMON_ARCHIVE`: a daemon archive built by
  `build-box-daemon.mjs`; E3, E4, and E7 use it without rebuilding Docker.
- `HETZNER_API_TOKEN`: only E7, for the provider-level reset action.
- `LAB_OLD_CP_ORIGIN`: only E15. It must be an old/no-payload-field fixture
  deployment that accepts the workspace's existing box bearer.
- `LAB_401_ORIGIN` and `LAB_5XX_ORIGIN`: only E9. They are fixture origins
  that consistently answer those classes without logging request headers.

`LAB_WORKSPACES` is a whitespace-separated list consumed by `run-all.sh`.
Each E script also accepts `<workspace-id> [machine-id]`. E14 requires two live
member machines in its workspace. Tests that require an in-flight turn fail
loudly unless the daemon `/state` probe reports one; the orchestrator owns
starting a suitably long turn before E1, E2, E4, and E13.

The production publisher has no test-only overlay flag. `publish_variant`
therefore clones the current checkout into a temporary directory, copies one
mutated file from an overlay directory into that clone, commits the resulting
tree so its content-derived version is honest, and invokes
`publish-box-payload.mjs --repo <clone>`. E5 and E12 then overwrite one
versioned test object to make failures that a validating publisher correctly
refuses to emit.

Useful tuning variables are `LAB_OUTCOME_TIMEOUT`, `LAB_DAEMON_IDLE_CAP`,
`LAB_TURN_TIMEOUT`, `LAB_E13_COMMAND`, and `LAB_HEALTH_PATH`. The E2 contract
defaults `LAB_HEALTH_PATH` to `/healthz`; changing it to `/diag` is useful only
while bringing up a deployment that has not exposed the specified health path.
`LAB_DAEMON_IDLE_CAP` must equal the box's
`BLITZ_PAYLOAD_DAEMON_IDLE_WAIT`; it defaults to the design's 600 seconds.

Dry-run every experiment without credentials or network access:

```sh
PAYLOAD_LAB_DRY=1 packages/box/test/payload-lab/run-all.sh
```

Real three-run matrix:

```sh
LAB_WORKSPACES='workspace-one workspace-two' \
  packages/box/test/payload-lab/run-all.sh
```
