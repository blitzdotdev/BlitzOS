# QA sweep lane prompt

## Assignment

- Run ID: `{{RUN_ID}}`
- Lane ID: `{{LANE_ID}}`
- Row IDs: `{{ROW_IDS}}`
- Source commit: `{{SOURCE_COMMIT}}`
- Artifact directory: `{{ARTIFACT_DIRECTORY}}`

Test only the assigned rows. Read each row and its cited sources before you
act. Return one verdict for each row ID.

## Environment

```text
Origin:             {{ORIGIN}}
Workspace ID:       {{WORKSPACE_ID}}
Member:             {{MEMBER}}
Session token file: {{TOKEN_FILE}}
CDP port:            {{CDP_PORT}}
Browser container:  {{CONTAINER_NAME}}
Claude signed in:    {{CLAUDE_SIGNED_IN}}
Fixture notes:       {{FIXTURE_NOTES}}
```

Use `qa/harness/driver.mjs` as the starting point. Keep the origin, workspace,
token file, CDP port, and artifact directory as lane parameters. Do not add
them as constants in a copied driver.

## Rules of engagement

1. Follow `qa/RUNBOOK.md`.
2. Use a lane-owned `chromedp/headless-shell` container with a unique name and
   CDP port. Add self-cleanup when you start it.
3. Never stop, remove, or kill a process, container, machine, session, file,
   worktree, or tab that this lane did not create or explicitly take over.
4. Keep concurrent lanes on separate browser contexts, artifact directories,
   mutable fixtures, container names, ports, volumes, and daemon data.
5. Confirm all preconditions before you judge product behavior. Do not treat a
   wrong membership, stale cookie, empty catalog, signed-out agent, missing
   branch, or port conflict as a product failure.
6. Prefer roles, labels, stable data attributes, and DOM state. Do not use
   one-off click coordinates.
7. Do not stop the box Lody daemon to free port 17789. Its permanent lease means
   the daemon-backed suite cannot pass locally in the same namespace.
8. Clean up only the resources listed in this lane's creation record.

`HEADLESS+PROMPT` rows need Claude to be signed in on the QA box. If the
environment says it is signed out, return `BLOCKED` for rows that need an
assistant turn.

## Verdict discipline

Use `PASS`, `FAIL`, or `BLOCKED` for the current run.

- `PASS` means the observed behavior matches the matrix row.
- `FAIL` means verified product behavior contradicts the row.
- `BLOCKED` means a required credential, fixture, service, or state is absent.

Retry every unexpected result once from a fresh page load and browser context.
Before you report `FAIL`, try to refute it: verify the preconditions, use a
second stable selector, inspect the DOM, and test the closest valid
counterexample.

Every `FAIL` must include a screenshot and DOM evidence. Also include the retry
result, console or request evidence when relevant, and the adversarial check.
Do not report a failure from a screenshot alone.

## Response format

Return a table with one row per assigned ID:

| Row ID | Verdict | Evidence | Retry | Adversarial check | Cleanup |
|---|---|---|---|---|---|
| `{{ROW_ID}}` | `PASS/FAIL/BLOCKED` | Screenshot and DOM paths or block reason | Fresh-load result | Refutation attempted and result | Lane-owned resources removed |

After the table, list confirmed flips against `qa/baseline.json`. Do not call a
coverage update or a result from another run a flip.
