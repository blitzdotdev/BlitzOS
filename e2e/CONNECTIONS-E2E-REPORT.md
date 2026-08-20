# Connections e2e report — NOT RUN

Successor of `CREDENTIALS-E2E-REPORT.md` for the connections product noun.
Suite: `e2e/connections.mjs` (`CP_URL`, `OPERATOR_API_KEY`, `MACHINE_TYPE`,
optional `CONNECTION_PROVIDER`).

**Status: not executed.** The suite ships with the connections change; nobody
has run it against a live instance yet, and every row below is therefore
`NOT RUN`, not `PASS`. Fill this table from the JSON summary the suite prints,
the way `CREDENTIALS-E2E-REPORT.md` was filled.

## What makes this tier different

`credentials.mjs` created its own org connections from operator-supplied
provider keys. `connections.mjs` creates nothing: the product path is per-user
grants, so the suite **discovers** what the target instance already has —
`GET /connections/catalog` for the provider declarations,
`GET /connections/grants` for the operator's own authorizations — picks a
connected provider, and asserts what that grant actually puts on a box. An
instance with no grants SKIPs the box-side gates instead of inventing one, and
teardown never revokes the discovered grant: it was not this run's to create.

## Result by gate

| Step | Gate | Result | Evidence |
|---|---|---|---|
| 0 | preflight: config, ed25519 keypair | NOT RUN | |
| 1 | discovery: catalog + grants, no token material in either response | NOT RUN | |
| 2 | workspace created with `connections: [provider]`, reaches ready | NOT RUN | |
| 3 | the first login shell mints: an active lease exists after it, and every lease records an owner | NOT RUN | |
| 4 | a fresh login shell exports the manifest's environment names (lengths only, never values) | NOT RUN | |
| 5 | the skill file lands at `/var/lib/blitz/home/.claude/skills/<provider>/SKILL.md` with the frontmatter naming the connection | NOT RUN | |
| 6 | proxy data path: an unauthenticated call is 401, the leased call is not | NOT RUN | |
| 7 | revocation symmetry: after revoke + `blitz-cred sync` the skill file is 0 bytes and the names are unset | NOT RUN | |
| 8 | connect inbox: asking for an unconnected provider files exactly one pending request | NOT RUN | |
| T | teardown: workspace destroyed, inbox entry denied, grant untouched | NOT RUN | |

## Safety rails carried over from the credentials suite

- Workspace ids are ledgered before any destroy, and the protected id is refused.
- `OPERATOR_API_KEY` is stripped from every child process environment.
- Credential values are never printed: step 4 and step 7 read variable
  **lengths**, and `safeText` redacts the session cookie and bearer tokens from
  every reported line.
