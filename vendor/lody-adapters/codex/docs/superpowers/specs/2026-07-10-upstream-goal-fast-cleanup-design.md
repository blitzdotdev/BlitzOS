# Upstream Goal/Fast Cleanup Design

## Objective

Remove the fork-specific goal implementation added by commit `20f61f9` now that upstream implements goal behavior. Keep the fork-only Plan Mode because upstream does not implement it. Keep Fast Mode as an upstream-owned feature and align the ACP SDK dependency with upstream.

## Historical Boundary

The fork-specific goal layer was introduced by `20f61f9` after the shared base `37a98b3`. It added ACP extension routes for `thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`; raw goal notifications; a custom no-argument `/goal` view; and corresponding tests.

Fast Mode was introduced before the fork diverged by upstream commit `64d3bc2`. The fork has no independent Fast Mode implementation to remove. Later upstream commits `fbc8f84` and `ef5e169` own model-capability filtering and boolean config support.

Upstream does not contain `PlanModeConfig.ts` or the fork's collaboration-mode plumbing, so Plan Mode remains fork-owned.

## Selected Approach

Use a symbol-level cleanup based on the historical diff rather than replacing entire files with upstream versions. This removes only the duplicated goal layer while preserving unrelated fork extensions and Plan Mode.

Whole-file replacement was rejected because files such as `AcpExtensions.ts`, `CodexAcpServer.ts`, and `CodexEventHandler.ts` also contain retained fork behavior for usage, rate limits, proposed plans, packaging identity, and Plan Mode.

Reverting all of `20f61f9` was rejected because it would remove retained features and create a substantially larger reconstruction diff.

## Runtime Changes

### Remove fork goal extensions

- Remove the `THREAD_GOAL_GET_METHOD`, `THREAD_GOAL_SET_METHOD`, and `THREAD_GOAL_CLEAR_METHOD` ACP extension constants and request types.
- Remove their Zod request parsers and server route registration from `src/index.ts`.
- Restore extension-method dispatch to the upstream-supported authentication and legacy model methods.
- Remove fork-only goal parameter parsing and wrapper methods from `CodexAcpServer` and `CodexAcpClient`.
- Remove only `threadGoalGet` from `CodexAppServerClient`. Retain upstream's `threadGoalSet`, `threadGoalClear`, `runGoalSet`, and `runGoalClear` implementation.

### Use upstream goal behavior exclusively

- Restore the upstream `/goal` command behavior, including the no-argument usage message.
- Remove the fork-only goal summary formatting and direct goal lookup.
- Stop forwarding `thread/goal/updated` and `thread/goal/cleared` as raw ACP notifications.
- Retain upstream `session_info_update` goal metadata, duplicate suppression, continuation-turn routing, grace periods, and cancellation behavior.

### Retain Plan Mode

- Keep `src/PlanModeConfig.ts` and its tests.
- Keep `planModeEnabled` and `planModeExplicitlySet` session state.
- Keep the `collaborationMode` turn parameter and plan/default mode switching.
- Keep `_acp_ext:codex_proposed_plan` streaming/completion notifications.
- Keep `experimentalApi: true` and `requestAttestation: false` as the existing fork capability configuration required by the retained Plan Mode integration.

### Retain unrelated fork extensions

- Keep `_acp_ext:session_usage_update`.
- Keep `_acp_ext:session_rate_limits`.
- Keep authentication extensions, the legacy session-model extension, fork package identity, and fork binary names.

## Fast Mode and SDK Alignment

Fast Mode remains enabled and should behave exactly like upstream:

- expose Fast Mode only for models with a fast speed tier;
- use boolean config options when the ACP client advertises support;
- otherwise use the upstream select option;
- retain the selected preference across model switches but apply the service tier only to supported models.

`src/FastModeConfig.ts` must have no fork-only behavioral diff from `upstream/main`. Adjacent `CodexAcpServer` changes may differ only where Plan Mode is inserted.

The dependency range for `@agentclientprotocol/sdk` must match `upstream/main` exactly (`^1.2.1` at design time). The resolved SDK package and transitive dependency graph in `package-lock.json` must follow upstream; only fork root metadata such as package name, version, and binary name may differ.

## Tests and Fixtures

- Delete `thread-goal-ext-methods.test.ts`.
- Restore upstream `thread-goal-events.test.ts` expectations and its three goal metadata snapshots.
- Remove the fork-only no-argument goal-view test and restore the upstream missing-input test.
- Keep upstream goal runtime, routing, cancellation, deduplication, and metadata coverage.
- Keep Plan Mode and proposed-plan tests unchanged except for mechanical fixture updates if required.
- Keep upstream Fast Mode tests unchanged.

## Error Handling and Compatibility

Requests to the removed fork-only goal extension routes will no longer be registered. Goal operations remain available through upstream's `/goal` command and app-server flow.

No compatibility shim or deprecation response will be added because the requested outcome is complete removal of the local implementation.

## Verification

1. Confirm no fork goal constants, parsers, wrappers, raw notifications, or tests remain.
2. Compare Fast Mode source and behavior with `upstream/main`.
3. Compare the SDK dependency range and resolved package with `upstream/main`.
4. Run targeted goal, Plan Mode, proposed-plan, Fast Mode, and initialization tests.
5. Run `npm run typecheck` and `npm test`.
6. Run `npm run build`, `npm pack --dry-run`, and `npm run bundle:all` with the CI Bun version.

## Success Criteria

- Goal behavior is provided only by upstream code paths.
- Fast Mode and the ACP SDK follow upstream.
- Plan Mode and unrelated fork extensions remain functional.
- The repository passes the full verification workflow with a clean working tree after commit.
