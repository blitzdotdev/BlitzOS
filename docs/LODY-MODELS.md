# How a new Anthropic model reaches the Lody composer

Investigated 2026-09-01, prompted by "Claude Fable 5.1 does not appear in the
model picker". The short answer: **model discovery is already dynamic and
nothing in BlitzOS or Lody needs a per-model edit — the ceiling is the
`@anthropic-ai/claude-code` version pinned in `packages/box/Dockerfile`.**

## 1. The discovery chain (dynamic, end to end)

Nobody maintains a model list for the picker. The chain is:

| # | Where | What it does |
|---|---|---|
| 1 | `claude` CLI (`/usr/local/bin/claude` shim → `/opt/blitz/npm/bin/claude`) | Answers the ACP/SDK `initialize` control request with its own `models` array |
| 2 | `lody/dist/claude-acp.js` (the bundled Claude ACP adapter) | `allowedModels = initializationResult.models` when `settings.availableModels` is unset, then `availableModels: models.map(m => ({modelId: m.value, name: m.displayName, description: m.description}))`. **Pure passthrough — it never adds or invents a model.** |
| 3 | `apps/cli/src/agent/acp-capabilities.ts` (`fetchAcpCapabilities`) | Spawns the adapter with no prompt, reads the `session/new` response, normalizes it, kills the process |
| 4 | Machine Flock `acpCapability` rows | Where the normalized capabilities land |
| 5 | `components/shared/acp-selector-options.ts` | Builds the composer's mode / model / effort selectors from those rows (`authority: 'authoritative'`) |

BlitzOS drives step 3 itself, from
`packages/webapp/src/lody/agent-configs.ts` → `refreshLodyAcpCapabilities()`,
because upstream's own startup pass lists no machines here (its `listMachineIds`
port answers from the Convex-authorized machine set, which the box is not in).
Cost measured upstream: ~2 s per builtin config, no turn spent.

### The static list is only a fallback

`vendor/lody/packages/shared/src/ai.ts` has `CLAUDE_STATIC_MODELS`
(`default` / `opus` / `claude-fable-5[1m]` / `sonnet` / `haiku`). That list is
served with `authority: 'provisional'` and **only** when no capability row
exists yet (`acp-selector-options.ts:262`). Once the refresh above lands, the
authoritative list replaces it. Editing that array does not add a model to a
working box — it changes what a box shows before its first probe.

## 2. Did upstream Lody need to change? No.

Neither the vendored subtree nor the npm daemon gates on a model list.
The one place a model list can be narrowed is Claude Code's own
`settings.availableModels`, which the adapter applies as an **allowlist filter**
over `initializationResult.models` (`applyAvailableModelsAllowlist`). It can
only remove entries, never add one — so there is no settings-side workaround
either. `CLAUDE_MODEL_CONFIG` parses to the same two keys
(`{modelOverrides, availableModels}`) and has the same property.

## 3. What actually blocks Fable 5.1

`packages/box/Dockerfile:36` pins `@anthropic-ai/claude-code@2.1.228`.
That binary has no `claude-fable-5-1` string at all (it knows
`claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-mythos-5`,
`claude-haiku-4-5`), so step 1 above never reports it.

The server enforces the same floor independently. Measured on this box:

```
$ claude --model claude-fable-5-1 -p "reply with: ok"
API Error: 400 Claude Code 2.1.228 does not support this model;
version 2.1.251 or newer is required.
```

So even a UI that offered the model would fail at dispatch. `claude-fable-5-1`
is the current top model (`claude-fable-5` is now listed as legacy).

## 4. Path forward

**The fix is a version bump plus a box-image rebake — no code change.**

1. Raise `@anthropic-ai/claude-code@2.1.228` to `>= 2.1.251` in
   `packages/box/Dockerfile` (latest published at the time of writing:
   `2.1.257`). `packages/broker/Dockerfile:12` carries the same pin and should
   move with it.
2. Rebake canary per `docs/BOX-IMAGE.md` and land the new
   `BLITZ_DEPLOY_VAR_BOX_IMAGE_*` values in `.github/workflows/canary.yml`.
   Do **not** cut a `v*` tag to refresh an image — the same tag ships client
   prod.
3. Re-measure the four `2.1.228` assertions that pin observed CLI bytes:
   `packages/webapp/test/lody-acp-authentication.test.ts`,
   `packages/box/guest-tests/test/remote-control-service.test.ts`,
   `packages/control-plane/test/bootstrap.test.ts:771`, and the fixture note in
   `packages/schema/fixtures/lody-session-control-stream/README.md`.
4. Verify on the rebaked box that the composer offers Fable 5.1 and that a turn
   dispatches. The one thing worth watching: `claude-acp.js` carries the Agent
   SDK's own baked model catalog (context windows, effort multipliers,
   `latest_per_family`) alongside the passthrough. It is not a filter, but a
   model absent from it may lose effort/context metadata until the `lody` pin
   moves (`0.88.1` here; `0.89.3` published).

### Standing rule for the next model

A new Anthropic model needs **no BlitzOS change**. It appears on its own once
the box image ships a Claude Code new enough to report it, because the whole
chain from `initialize` to the composer is passthrough. Treat "model X is
missing" as "the box-image Claude Code pin is behind", and check the pin first.

Two things would make that automatic and are deliberately not done:
`DISABLE_AUTOUPDATER=1` in the PATH shim (a self-updating vendor CLI drops a
second copy into the member's npm prefix and shadows the shim — a terminal
signed out on a box that holds a valid credential), and the
`runtimeOverrides.claudeCodeExecutable` on every builtin agent config, which
short-circuits Lody's managed-runtime download of a second unpinned binary from
Lody's R2 channel. Both pins are load-bearing; the answer is to move the image
pin on a cadence, not to unpin.
