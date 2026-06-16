# Full removal of the OAuth integrations subsystem

**Decision (user, 2026-06-16):** remove the OAuth integrations subsystem ENTIRELY and scrub the
agent doctrine to browser-first. The agent works the user's tools ONLY through logged-in web
surfaces (`read_window` / `surface_control`). There is no OAuth/`provider_call`/`blitz.data` path
anymore.

**Verified safe:** the browser session (`persist:agentos` partition, `.../Partitions/agentos/`)
is wholly separate from this subsystem — it stays. The user's in-browser logins are untouched.

## Scope calls (made here; flag if wrong)
1. **Server backend too.** `preview/backend.mjs` (browser-preview mode) ports the same provider
   engine + an OAuth registry. Full removal guts that too (provider routes, the registry, the
   imports). The preview server keeps surfaces/agent-socket/screencast; it loses provider data.
2. **`approval-queue` is provider-only** (its sole broadcast is `provider-approval`, types come
   from `provider-call.mjs`). It goes with the subsystem. (Surface-mutation write-confirm + STOP
   are NOT this; they are unaffected.)
3. **Inert scan tag stays.** `scan.web.workflow[].integration` is a data hint in scan.json, not an
   OAuth mechanism, and nothing consumes it once the subsystem is gone. Leave it (not doctrine).

## DELETE (whole files)
- `src/main/integrations.ts`, `src/main/oauth.ts`, `src/main/tokenStore.ts`
- `src/main/provider-bridge.ts`
- `src/main/provider-call.mjs` + `provider-call.d.mts`
- `src/main/provider-specs.mjs` + `provider-specs.d.mts`
- `src/main/approval-queue.mjs` + `approval-queue.d.mts`  (provider-only)
- `src/renderer/src/components/ConnectPanel.tsx`, `src/renderer/src/components/IntegrationWidget.tsx`
- `widgets/github-repos.html`, `widgets/discord-servers.html`
- the live token file `~/Library/Application Support/agent-os/integrations.json`

## EDIT (remove every reference; keep the rest of the file working)
- `src/main/index.ts` — drop `registerIntegrations` import+call; drop the `provider-bridge` imports
  (`setProviderBroadcast`/`resolveProviderApproval`/`denyProviderApproval`/`grantProviderConsent`/
  `setProviderConsentPersist`/`loadProviderConsent`) and any `os:provider-*` / `integrations:*` /
  `widget:consent` IPC handlers wired to them. KEEP `permission-request` (browser perms, unrelated).
- `src/main/agentSocket.ts` — drop `injectConnectors` import; `agentsMd: AGENTS_MD` directly.
- `src/main/electron-os-tools.ts` — drop `runProviderCall` + `integrationStatuses`/`connectedProviders`
  imports and the `providerCall`/`integrationStatuses`/`connectedProviders` ops bindings.
- `src/main/os-tools.mjs` — remove `PROVIDER_WEB_HOSTS` + the `account_hint` block in the state
  serializer; remove the `/provider_call` and `/list_integrations` tools; remove
  `connectedProviders`/`integrationStatuses` usage (spawn_widget `needsConnect`, list_state arg);
  update the ops JSDoc. `account_hint` text out of `list_state` description.
- `src/main/widget-tools.mjs` — drop `provider_call` from the allowed set + its handler.
- `src/main/widgets.ts` — drop `loadRecord`/`fetchProviderResource`/`PROVIDER_DATA` usage; remove the
  provider data path (server widget data fetch).
- `src/main/widget-catalog.mjs` — drop `callProvider`/`resourceRoute` imports, `PROVIDER_DATA`,
  `listProviderResources`, `fetchProviderResource`; remove the `blitz.data` doctrine + the
  `needs`/`needsConnect`/provider-backed-widget guidance from the authoring markdown (keep library
  mgmt + the rest of the authoring doctrine, including the reserved-globals + design-ref rules).
- `src/main/activity.mjs` — drop `/provider_call` from the labels list + its case.
- `src/main/control-server.ts`, `src/renderer/src/components/SurfaceFrame.tsx` — comment-only mentions; tidy.
- `src/preload/index.ts` — drop the `integrations` bridge (`list/connect/disconnect`),
  `grantConsent`, `os:provider-approve/deny/consent`, `grantProviderConsent`, the `provider-approval`
  os:action type. KEEP `permission-request`.
- `src/renderer/src/store.ts` — drop integrations state + actions.
- `src/renderer/src/App.tsx` — drop `IntegrationWidget`/`ConnectPanel` imports + their render blocks +
  the `connecting`/`integrations` state/dock entry.
- `src/renderer/src/widget-bridge.ts` — drop the `data` op (blitz.data) from the bridge shim; keep tool/props/ui.
- `widgets/widgets.json` — remove the `github-repos` + `discord-servers` entries.
- `preview/backend.mjs` + `preview/RUNNING.md` — remove the provider registry, OAuth routes,
  provider-call/specs imports, integrations.config.json handling.
- DOCTRINE: `src/main/blitzos-agents.md` (the `## provider_call` section, `## Your connectors`
  + `{{CONNECTORS}}`, `account_hint` guidance, the `blitz.data`/integration-backed-widget lines →
  rewrite browser-first: tools are worked through logged-in web surfaces only),
  `src/main/blitzos-interview.md` (the 1 OAuth line in the sign-in beat → browser-only),
  `src/main/blitzos-onboarding.md` (2 refs).

## VERIFY (acceptance — all must pass)
1. `npm run typecheck` clean.
2. `npm run build` succeeds (catches .mjs runtime import breaks tsc misses).
3. `grep -rIE 'integrations|provider_call|providerCall|blitz\.data|account_hint|PROVIDER_WEB_HOSTS|injectConnectors|ConnectPanel|IntegrationWidget|tokenStore|loopbackAuthorize|integrationStatuses|connectedProviders|list_integrations|needsConnect|\{\{CONNECTORS\}\}' src/ preview/ widgets/ src/main/*.md` returns ZERO (plan/issue docs may still mention it; that's fine).
4. `node scripts/test-onboarding-seed.mjs` + the stage tests still pass (no collateral).
