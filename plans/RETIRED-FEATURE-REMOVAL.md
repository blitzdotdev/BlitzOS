# Retired feature removal

Status: implemented on 2026-09-05.

## Product boundary

- Remove Org Drive, usage capture, microVM hosting, templates, recipes, and their obsolete aliases.
- Keep workspace files, repository cloning, cloud compute, and deployed-box compatibility.
- Historical plans can name retired systems as evidence, but they do not define current support.

## Org Drive and usage capture

- Delete Drive routes, schemas, database access, R2 object flows, synchronization, dialogs, screens, tests, and styling.
- Delete usage capture because it only wrote transcripts into Drive.
- Remove the five-minute synchronization cron.
- Keep the R2 binding for box image archives.
- Purge only keys below `org/` after deployment.
- Keep dufs and the gateway `/files` surface.
- Keep the workspace file browser, file drops, and Lody attachments.
- The browser reads the guest WebDAV surface directly. It never used Drive.

## Compute

- Delete the Firecracker host package, provider, registry, registration route, configuration, deployment hooks, documentation, and tests.
- Keep Hetzner and AWS providers.
- Keep workspace tunnels and their webApp tokens.
- Keep port 7444 for deployed boxes.

## Templates, recipes, and repositories

- Delete template and recipe schemas, routes, database fields, clients, screens, fixtures, bootstrap logic, and tests.
- Rename shared repository helpers to workspace repository names.
- Keep workspace repository cloning.

## API boundaries

- Redirect signed-in root requests to the first controllable workspace.
- Show the workspace empty state when no controllable workspace exists.
- Reject retired create-workspace fields and every other unknown field.
- Accept only the canonical phone-home request.
- Return only `box_id`, `access_token`, and `refresh_token` from phone-home.
- Remove the old phone-home adapter and legacy fixtures.
- Current deployed cloud boxes already send the canonical request.
- Remove the `/integrations` API alias and the `/settings/integrations` UI alias.

## Deployed-box compatibility

- Keep `GET /boxes/:id/feed` because deployed boxes still call it.
- Keep the constant `GET /workspaces/:id/environment` response.
- Keep migrated token families without changing their hashes.
- Keep box-config v1 and its host updater.
- Keep current phone-home, tunnel, webApp token, and gateway contracts.
- Treat these items as intentional compatibility, not retired product support.

## Migration and deployment

- Apply migration `0050_remove_retired_features.sql` before the new Worker deployment.
- The migration drops retired tables, columns, indexes, and foreign keys.
- Deploy the new Worker immediately after the migration.
- Remove the obsolete five-minute cron during that deployment.
- Purge retired `org/` R2 keys after the new Worker is active.
- Do not delete box image objects.
- Rebuild the webApp with the Worker deployment.
- Run typecheck, lint gate, and all tests before release.

## Recovery

- Restore removed products only through a new design and migration.
- Do not restore retired aliases or permissive request parsing.
- Preserve the deployed-box compatibility surfaces until an explicit image retirement removes them.
