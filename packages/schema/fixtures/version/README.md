# Version fixtures

`GET /version` on the control plane reports which commit a deployment runs,
which box image it hands to new workspaces, and which D1 migration is applied.

The payload crosses a runtime boundary: the Worker produces it (TypeScript),
and `packages/control-plane/scripts/check-box-image.mjs` consumes it (Node).
Each fixture is one whole response body. Both sides read these files, so
neither side can change the shape alone.

| Fixture | Case |
|---|---|
| `deployed.json` | A deploy that recorded its commit. |
| `unknown-commit.json` | A config older than `GIT_COMMIT_SHA`. The route answers `"unknown"` rather than omitting the field. |
| `fresh-database.json` | A database with no readable `d1_migrations` table. `migration` is `null`, never an error. |
