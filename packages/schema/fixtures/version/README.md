# Version fixtures

`GET /version` on the control plane reports which commit a deployment runs,
which box-image reference and archive tag it hands to new workspaces, and which
D1 migration is applied. `boxImageTag` is empty for registry mode and contains
the local load tag for R2 archive mode.

The payload crosses runtime boundaries: the Worker produces it (TypeScript),
`packages/control-plane/scripts/check-box-image.mjs` reads `commit` (Node), and
the canary workflow's verify step reads `commit` and `boxImageTag` with `jq`.
Each fixture is one whole response body. The producer and consumer conformance
tests read these files, so neither side can change the shape alone.

| Fixture | Case |
|---|---|
| `deployed.json` | A mode-A registry deploy that recorded its commit. |
| `deployed-r2.json` | A mode-B deploy whose versioned manifest ref and image tag carry the same full release id. |
| `unknown-commit.json` | A config older than `GIT_COMMIT_SHA`. The route answers `"unknown"` rather than omitting the field. |
| `fresh-database.json` | A database with no readable `d1_migrations` table. `migration` is `null`, never an error. |
