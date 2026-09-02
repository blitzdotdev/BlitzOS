# QA sweep runbook

Use this runbook for each row in `qa/MATRIX.md`. Record one verdict for each
assigned row. Use the row ID as the stable key.

## 1. Prepare the lane

1. Record the run ID, lane ID, source commit, origin, workspace ID, member, and
   artifact directory.
2. Read the assigned matrix rows and all cited sources before you run them.
3. Check that the workspace has the state that each row needs. A fixture
   failure is not a product failure.
4. Use a separate browser container, CDP port, browser context, artifact
   directory, and mutable fixture for each lane.
5. Record every process, container, machine action, and test record that the
   lane creates. Clean up only these items.

Do not kill a process or container that the lane did not start. Do not reuse a
shared daemon data directory or `webapp_state` document for concurrent mutation
lanes.

## 2. Get or revive a QA box

The sanctioned automation surface is the agent machine plane in
`packages/control-plane/core/machine-plane.ts`. Read the origin from
`/var/lib/blitz/origin`. Read the box credential from
`/var/lib/blitz/box-credential.json` only when you make the request.

The machine plane permits these routes:

- `GET /workspaces`
- `GET /workspaces/:id`
- `GET /machine-types`
- `POST /machines/:id/provision`
- `POST /machines/:id/start`
- `POST /machines/:id/stop`
- `POST /machines/:id/recreate`
- `DELETE /machines/:id`

It does not permit workspace create or delete, membership, billing, device
authorization, or general session routes. It also does not permit a
machine-type change.

Use the credential in one short-lived subshell. Do not print it or write it to
an artifact.

```sh
(
  qa_origin=$(cat /var/lib/blitz/origin)
  qa_token=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/var/lib/blitz/box-credential.json", "utf8")).access_token)')
  qa_auth="Authorization: Bearer $qa_token"
  curl -fsS -H "$qa_auth" "$qa_origin/workspaces"
)
```

Resolve the exact workspace and machine ID before a lifecycle request. Start a
stopped QA machine when that is sufficient. Provision or recreate only when the
row needs it and the ownership check permits it. A box agent cannot recreate or
delete a person-created machine. Provision, recreate, and start can spend money
or replace compute state. Record the prior state and restore it when the lane
owns that change.

Do not use a workspace API route outside the allowlist as a substitute. Do not
use a stale IP address or another member's machine.

## 3. Mint the browser session

A D1-minted `blitz_session` cookie authenticates only the web control plane.
Mint it in the database that serves the target origin. The `sessions` row must
contain the hash of the cookie token, a valid expiry, the principal ID, and the
`membership_id` for an active membership in the target organization. A session
without `membership_id` can authenticate but cannot select the member's
workspace or machine correctly.

Do not copy a cookie from another origin. The cookie does not create a box
credential, webApp ticket, tunnel token, or Claude sign-in.

A hard navigation to `/workspaces/:id/chat` must send `Accept: text/html`.
This header selects the SPA shell. A fetch without this header takes the API
path and can return a JSON 404. Chromium sends the header on a normal page
navigation. Add it explicitly when a command-line probe must fetch the shell.

## 4. Start the lane browser

Use one `chromedp/headless-shell` container for each lane. Use unique names and
host ports. Keep the cleanup trap in the same shell that starts the container.
If the chosen name already exists, stop the lane setup and choose another name.
Do not remove the existing container.

```sh
qa_container="qa-${QA_RUN_ID}-${QA_LANE_ID}"
qa_cdp_port="${QA_CDP_PORT:?set a unique CDP port}"
qa_image="${QA_HEADLESS_IMAGE:?set the approved chromedp/headless-shell image}"
qa_container_id=""

if docker container inspect "$qa_container" >/dev/null 2>&1; then
  echo "Container name is already in use: $qa_container" >&2
  exit 1
fi

cleanup_qa_browser() {
  if [ -n "$qa_container_id" ]; then
    docker stop "$qa_container_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup_qa_browser EXIT INT TERM

qa_container_id=$(docker run --rm --detach \
  --name "$qa_container" \
  --publish "127.0.0.1:${qa_cdp_port}:9222" \
  "$qa_image" \
  --no-sandbox \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=9222)
```

Give each lane its own browser context and output directory. When a row needs
isolated box or daemon state, also give that lane unique container names,
volumes, mounts, and ports.

Run the reusable driver with lane-specific values:

```sh
node qa/harness/driver.mjs \
  --origin "$QA_ORIGIN" \
  --workspace "$QA_WORKSPACE_ID" \
  --token-file "$QA_TOKEN_FILE" \
  --cdp-port "$qa_cdp_port" \
  --out-dir "$QA_ARTIFACT_DIR"
```

The driver closes its browser context and CDP client connection. It does not
stop the browser process or container.

## 5. Respect the daemon port

The box s6 service permanently runs the Lody daemon and holds port 17789. The
daemon-backed webapp suite cannot pass locally in that same network namespace.
Its second daemon waits for the single-instance lease and reaches its startup
timeout.

Do not stop the box daemon and do not kill a process to free port 17789. Run a
daemon-backed suite in an isolated lane container and network namespace. If the
only local failure is the known 17789 startup timeout, record an environment
block. Do not record a product `FAIL`.

## 6. Run each row

1. Confirm the row's class and preconditions.
2. Load the target from a new browser context. Poll through capability and
   agent-config startup gates.
3. Perform only the actions that the row needs. Prefer roles, labels, and stable
   data attributes over coordinates.
4. Capture the result, a screenshot, relevant DOM state, console errors, and
   request evidence.
5. Clean up only the sessions, files, worktrees, tabs, machines, and containers
   that the lane created.

`HEADLESS+PROMPT` rows require Claude to be signed in on the QA box. The control
plane session cookie does not satisfy this requirement. If Claude is signed
out, use `BLOCKED`; do not infer behavior from a missing assistant turn.

## 7. Assign the verdict

Use only these campaign verdicts:

- `PASS`: The observed behavior matches the matrix row.
- `FAIL`: The product behavior contradicts the row after verification.
- `BLOCKED`: A required credential, fixture, service, or state is unavailable.

For an unexpected result, retry once from a fresh page load and new context.
Before you report `FAIL`, try to disprove it. Check the row's preconditions,
use a second stable selector, inspect the DOM, and test the closest valid
counterexample.

A `FAIL` needs all of this evidence:

- A screenshot that shows the user-visible state.
- DOM evidence that names the target and observed value or absence.
- The run ID, row ID, origin, workspace fixture, source commit, and time.
- Results from the fresh-load retry.
- The adversarial check and why it did not refute the finding.

Do not convert a timeout, signed-out agent, empty catalog, wrong membership,
missing base branch, or known port conflict into `FAIL`.
