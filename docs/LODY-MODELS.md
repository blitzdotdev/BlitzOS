# How a new Anthropic model reaches the Lody composer

Investigated 2026-09-01, prompted by "Claude Fable 5.1 does not appear in the
model picker". The short answer: **model discovery is already dynamic and
nothing in BlitzOS or Lody needs a per-model edit — the only ceiling is the
`@anthropic-ai/claude-code` version the box is running.** §4 measures the whole
path end to end: a `claude update` on a live box put Fable 5.1 in the composer
with no rebake, no code change and no vendor bump. What is missing is only the
trigger — the automatic updater is off in four places.

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

## 4. In-place CLI update reaches the composer — measured end to end

A rebake is **not** the only route. The chain above has no version gate
anywhere, so updating the CLI on a running box is sufficient. Measured on a
live box, 2026-09-01, in order:

```
$ claude --version                        # 2.1.228
$ claude --model claude-fable-5-1 -p ...  # 400: version 2.1.251 or newer is required
$ claude update
  Installation method set to: global
  Successfully updated from 2.1.228 to version 2.1.257
$ claude --version                        # 2.1.257  (through the shim)
$ ls ~/.local/bin ~/.claude/local          # empty / absent -- NO shadow copy
$ claude --model claude-fable-5-1 -p "reply with exactly: ok"
  ok
```

Then the adapter, spawned exactly as `setting.ts` spawns it for a builtin
`claude` config carrying `runtimeOverrides.claudeCodeExecutable`
(`node lody/dist/claude-acp.js` with `CLAUDE_CODE_EXECUTABLE=/usr/local/bin/claude`),
reported from `session/new`:

```
model configOption (what the composer renders), currentValue = default
  default              | Default (recommended)
  opus[1m]             | Opus (1M context)
  claude-fable-5-1[1m] | Fable        <-- new model, no image change
  sonnet               | Sonnet
  haiku                | Haiku
```

**No rebake, no code change, no vendor bump.** The `lody` pin stayed at 0.88.1
and the vendored static list was never consulted.

### Why it worked, precisely

- **`installMethod` resolved to `global`**, so the updater rewrote
  `/opt/blitz/npm/lib/node_modules/@anthropic-ai/claude-code` in place — the
  exact binary `/usr/local/bin/claude` execs, and therefore the exact binary
  Lody launches through `BLITZ_CLAUDE_EXECUTABLE`. The `~/.local/bin` shadow
  copy the Dockerfile comment warns about is what the **native** installer
  produces; the npm-global path does not take it. `NPM_CONFIG_PREFIX` being
  owned by uid 1000 is what makes the in-place rewrite possible — and the
  Dockerfile says that ownership exists so `claude` *can* auto-update.
- **The browser half re-probes unconditionally.**
  `runStartupAcpCapabilitiesRefresh` has no staleness check, no version compare
  and no cache: it refreshes every config every time it is called.
  `capabilitySourceVersion` is written onto the Flock row by the daemon but is
  never read anywhere in `packages/components/src`, so it gates nothing.
  BlitzOS calls the pass from `LodyAgentConfigGate`'s effect, keyed
  `[store, machineId, projectUrl]` and guarded by `started = runtime` — **once
  per runtime mount, i.e. once per load of the Lody surface.** A member who
  reloads the tab after an update gets the new list.

### The one thing that is actually off: the *automatic* updater

`DISABLE_AUTOUPDATER=1` is set in four places — `packages/box/Dockerfile:168`
(image-wide ENV), the PATH shim `rootfs/usr/local/bin/claude:27`,
`rootfs/etc/profile.d/blitz-npm.sh:23`, and
`broker/internal/vendor/vendor.go:104`, which strips any inbound value and
force-appends `=1` (asserted by `roaming_test.go:363`).

That flag gates the **background** update check only. The explicit `claude
update` subcommand ignores it: the run above was made with
`DISABLE_AUTOUPDATER=1` live in the environment and updated anyway. So today
nothing updates on its own, and nothing will until something runs `update`.

## 5. Path forward

**Decided 2026-09-01: keep the vendor's own auto-update path** — unset
`DISABLE_AUTOUPDATER` and let Claude Code update itself, rather than driving it
from an s6 oneshot. The four sites in §4 have to move together, and
`vendor.go:104` plus its `roaming_test.go:363` assertion are a deliberate
decision being reversed, not dead code.

The shadow-copy fear those comments cite is already handled independently:
`rootfs/etc/profile.d/blitz-npm.sh` force-moves `/usr/local/bin` to the FRONT of
PATH on every login shell, ahead of `/opt/blitz/npm/bin` (verified: a box login
shell gets `/usr/local/bin:/opt/blitz/npm/bin:…`). So a second copy in the npm
prefix cannot shadow the shim, and the native installer's `~/.local/bin` /
`~/.claude/local` are not on the box PATH at all. **Rewrite those comments when
the flag goes** — they are the justification the next agent will read, and they
will be wrong.

Still worth doing alongside:

1. **Bump the pin and rebake** (`packages/box/Dockerfile:36` and
   `packages/broker/Dockerfile:12`, then `docs/BOX-IMAGE.md`). Still correct for
   the *baked* floor, so a fresh box is not one update behind on first boot —
   but it should stop being the mechanism by which a new model arrives.

With the pin no longer deciding which models exist, these four
`2.1.228` assertions need re-basing on a range or a probe rather than a
literal: `packages/webapp/test/lody-acp-authentication.test.ts`,
`packages/box/guest-tests/test/remote-control-service.test.ts`,
`packages/control-plane/test/bootstrap.test.ts:771`, and the fixture note in
`packages/schema/fixtures/lody-session-control-stream/README.md`.

One thing to keep watching: `claude-acp.js` carries the Agent SDK's own baked
model catalog (context windows, effort multipliers, `latest_per_family`)
alongside the passthrough. It is not a filter — Fable 5.1 rendered fine without
being in it — but a model absent from it may lose effort/context metadata until
the `lody` pin moves (`0.88.1` here; `0.89.3` published).

### Standing rule for the next model

A new Anthropic model needs **no BlitzOS change and no vendor bump**. The chain
from `initialize` to the composer is passthrough and the capability re-probe is
unconditional, so "model X is missing" means "this box's Claude Code is behind".
Check `claude --version` before reading any of the code above.

The other pin, `runtimeOverrides.claudeCodeExecutable` on every builtin agent
config, must stay: it short-circuits Lody's managed-runtime download of a
second, unpinned agent binary from Lody's R2 channel, and it is also what makes
an in-place update of the npm-global prefix reach Lody at all.
