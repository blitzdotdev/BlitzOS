/**
 * The two agent configs a BlitzOS box may run
 * (plans/LODY-RUNTIME-DESIGN.md §6/§3.5, plans/evidence/lody-phase1.md §A.d).
 *
 * `runtimeOverrides` is NOT a per-dispatch parameter. It is a field on an
 * agent-config row in the machine Flock document (`atoms/agents.ts:140`), copied
 * into session meta at launch and read back by `components/ai-gui/view.tsx:2380`.
 * So the injection point is a bootstrap, run once per runtime, and this is it.
 *
 * WHY EVERY BUILTIN CONFIG MUST CARRY AN OVERRIDE. Without one the daemon
 * resolves its MANAGED runtime and downloads a second, unpinned agent binary
 * from Lody's R2 channel (`packages/platform/src/runtime-artifacts.ts`) — a
 * binary nothing on the box authenticates, updates or can reason about. With
 * one, `apps/cli/src/agent/setting.ts:441` short-circuits that path entirely
 * and spawns our binary: the box's own `claude`, which keeps itself current and
 * so decides which models this composer can offer (docs/LODY-MODELS.md).
 *
 * AND WHICH BINARY. `/usr/local/bin/claude` is the box's PATH SHIM, not the
 * vendor CLI: it mints a fresh OAuth token through `blitz-cred-claude` and execs
 * `/opt/blitz/npm/bin/claude`. Pointing the override at the vendor binary
 * directly would hand the adapter an unauthenticated CLI, because nothing else
 * in the daemon's environment carries `CLAUDE_CODE_OAUTH_TOKEN`. Credentials
 * therefore stay on the existing box path and never enter `config.env` — that
 * row is a synced CRDT, and `session/create.env` is the per-turn escape hatch
 * phase 6 uses instead.
 *
 * `kimi` and `grok` are never registered: they are managed-runtime-only and
 * there is no override to pin them with. `deepseek` is a builtin agent but not a
 * managed runtime, and §0.6 of the plan limits v1 to claude and codex anyway.
 */
import { getMachineFlockDocId, machineFlockKeys, readMachineFlockRowsFromFlock } from "@lody/shared";
import { setMachineFlockRowsForMachineAtom } from "@lody/components/atoms/machine-flock";
import { resyncMachineFlockRows } from "@lody/components/hooks/use-machine-flock-rows";
import { runStartupAcpCapabilitiesRefresh } from "@lody/components/providers/startup-acp-capabilities-refresh";
import type { LodyAtomStore, LodyWorkspaceRuntime } from "./runtime.js";

/** The shim, not `/opt/blitz/npm/bin/claude`; see the module comment. */
export const BLITZ_CLAUDE_EXECUTABLE = "/usr/local/bin/claude";
export const BLITZ_CODEX_PATH = "/usr/local/bin/codex";

/** Stable ids. `blitz-` prefixed so they never collide with the uuid the
 * settings dialog mints, which is what makes the bootstrap idempotent. */
export const BLITZ_CLAUDE_CONFIG_ID = "blitz-claude";
export const BLITZ_CODEX_CONFIG_ID = "blitz-codex";

/**
 * An agent-config row as `parseAgentConfigRaw` (`atoms/agents.ts:148`) accepts
 * it. `env` must be present and must stay empty; `description` is simply absent
 * (their parser reads a missing key and an undefined one identically).
 *
 * A `type` and not an `interface` on purpose: TypeScript gives a type alias an
 * implicit index signature, so the row goes into `flockRowPutIfAbsent` as a
 * `JsonValue` with no assertion at all.
 */
export type LodyAgentConfigRow = {
  id: string;
  machineId: string;
  name: string;
  cliType: "builtin";
  agentType: string;
  env: Record<string, string>;
  runtimeOverrides: { claudeCodeExecutable?: string; codexPath?: string };
};

/**
 * The rows this box should have.
 *
 * `agentType` is `'claude'`, not `'claude-code'`. The design doc says the
 * latter; the code disagrees and wins — `'claude-code'` is the RUNTIME NAME in
 * `MANAGED_BUILTIN_RUNTIMES` (`vendor/lody/packages/shared/src/ai.ts:21`), while
 * the agent type beside it is `'claude'`, and
 * `usesAcpProvidedSessionTitle` (`:47`) branches on exactly that string.
 */
export function blitzAgentConfigRows(machineId: string): LodyAgentConfigRow[] {
  return [
    {
      id: BLITZ_CLAUDE_CONFIG_ID,
      machineId,
      name: "Claude Code",
      cliType: "builtin",
      agentType: "claude",
      env: {},
      runtimeOverrides: { claudeCodeExecutable: BLITZ_CLAUDE_EXECUTABLE },
    },
    {
      id: BLITZ_CODEX_CONFIG_ID,
      machineId,
      name: "Codex",
      cliType: "builtin",
      agentType: "codex",
      env: {},
      runtimeOverrides: { codexPath: BLITZ_CODEX_PATH },
    },
  ];
}

/**
 * Writes any missing row. Returns the ids it created.
 *
 * TWO THINGS MAKE IT IDEMPOTENT, AND PHASE 2 HAD NEITHER (design doc §7, the
 * `TODO(lody-phase3)` this replaces).
 *
 * 1. **The room is awaited.** `openFlockDoc(...).syncOnce()` resolves once the
 *    machine Flock room has exchanged state, so what follows sees the daemon's
 *    rows rather than an empty local mirror. Phase 2 read a jotai cache fed by
 *    that room and, running first, always saw nothing.
 * 2. **The write is `flockRowPutIfAbsent`.** Absence and insertion are decided
 *    in ONE transaction, so a CLI write that lands between a check and a put
 *    cannot be overwritten. `flockRowPut` is an LWW put: it would silently undo
 *    a member's rename on every boot.
 *
 * `syncOnce` failing is not fatal and is not retried here: the fallback is the
 * local mirror, and `flockRowPutIfAbsent` is still atomic against it. A row that
 * exists only on the daemon and has not reached us yet converges through the
 * CRDT, so the worst case is a duplicate insert the merge resolves — never a
 * lost override.
 */
export async function bootstrapLodyAgentConfigs(
  store: LodyAtomStore,
  runtime: LodyWorkspaceRuntime,
  machineId: string,
): Promise<string[]> {
  const flockDocId: string = getMachineFlockDocId(runtime.workspaceId, machineId);
  const handle = await runtime.repo.openFlockDoc(flockDocId);
  await handle.syncOnce().catch(() => {
    // The local mirror is the fallback; see the doc comment. Swallowed rather
    // than logged because the surface has no console chokepoint of its own and
    // the next line's result is the observable outcome either way.
  });

  const created: string[] = [];
  for (const row of blitzAgentConfigRows(machineId)) {
    // SAFETY: `machineFlockKeys.agentConfig` is Lody's own key builder for this
    // row family; the seam erases its `readonly string[]` return type.
    const key = machineFlockKeys.agentConfig(row.id) as readonly string[];
    const result = await runtime.writer.flockRowPutIfAbsent(flockDocId, key, row);
    if (result.inserted) created.push(row.id);
  }

  // AND THEN PUSHED, WHICH IS THE WHOLE OF FIX A.
  //
  // `WorkspaceWriter`'s accept boundary is the LOCAL CRDT write, not remote sync
  // (`providers/workspace-writer.ts:52`). So the loop above resolves while the
  // daemon still has no row, and the composer is already usable, because the
  // jotai publish below feeds the same picker. A prompt sent in that window
  // creates a session whose `agentConfigId` names a row the daemon cannot see,
  // and `resolveSessionLaunchConfig` (`apps/cli/src/session/
  // session-launch-config-resolver.ts:57`) FAILS OPEN: it returns
  // `source: 'none'` with no `runtimeOverrides` rather than refusing. The
  // adapter then launches the MANAGED claude runtime instead of the box shim,
  // nothing carries a token, and the turn comes back `acp_auth_required` — the
  // canary finding, reproduced from the seam.
  //
  // A second `syncOnce` exchanges state with the room again, this time with our
  // ops in it, so the row is on the daemon before this resolves. Its caller then
  // gates the surface on that (`SessionSurface.tsx`, `LodyAgentConfigGate`).
  //
  // Swallowed like the first one: a failed push leaves the local mirror, which
  // is still better than no rows at all, and the gate opens either way rather
  // than trapping the member behind a spinner.
  await handle.syncOnce().catch(() => {
    // See above: the local mirror is the fallback, and the gate must still open.
  });

  // Publish the room's rows into the jotai cache the UI reads, exactly as
  // `writeAgentConfigToMachineFlock` (`atoms/agents.ts:42`) does after its own
  // write. Without this the composer's agent picker stays empty until the
  // mirror's next tick.
  store.set(setMachineFlockRowsForMachineAtom, {
    workspaceId: runtime.workspaceId,
    machineId,
    rows: readMachineFlockRowsFromFlock(handle.flock),
    mode: "merge",
  });
  return created;
}

/**
 * Fills the composer's mode / model / effort selectors.
 *
 * WHY THIS IS OURS TO CALL. `createWorkspaceRuntime` already runs a startup
 * capabilities refresh (`:2413`), but its `listMachineIds` port answers from
 * `deps.getAuthorizedMachineIds()` — the CONVEX-authorized machine set. The box
 * is visible to the renderer only through `buildVisibleMachineIndex`'s
 * owner fallback (`lib/visible-machine-index.ts:64`), which deliberately stays
 * out of `convexAuthorizedMachineIds`, so upstream's pass lists no machines and
 * never runs. Without it the machine Flock has no `acpCapability` rows,
 * `buildAcpSelectorOptions` has nothing to build from, and the composer offers
 * NO permission mode, model or effort — which also means no way to leave the
 * `auto` mode whose classifier answers permission prompts on the member's
 * behalf (`BUILTIN_DEFAULT_MODE_IDS.claude`, `shared/src/ai.ts:402`).
 *
 * The pass itself is THEIRS, unchanged: `runStartupAcpCapabilitiesRefresh`
 * serializes per machine, tolerates a failing config, and resyncs the Flock the
 * way its own caller does. Only the four ports are ours.
 *
 * Measured cost on a cold daemon: ~2 s per builtin config, and it launches the
 * adapter without sending a prompt, so it spends no turn.
 */
export async function refreshLodyAcpCapabilities(
  runtime: LodyWorkspaceRuntime,
  machineId: string,
  options: {
    /** Aborted when the surface unmounts. Without it a refresh still in flight
     * outlives the runtime and reports a transport failure against a daemon
     * that is already gone. */
    signal?: AbortSignal;
    onError?: (cause: unknown, configId: string | undefined) => void;
  } = {},
): Promise<void> {
  await runStartupAcpCapabilitiesRefresh({
    listMachineIds: async () => [machineId],
    // The box IS the local machine and `syncMode: 'local'` routes every call to
    // it without a presence probe, so there is nothing to be offline about.
    // Upstream gates on presence because it can dispatch to somebody else's
    // laptop; we cannot.
    isMachineOnline: () => true,
    listAgentConfigs: async () => blitzAgentConfigRows(machineId),
    refreshAgentConfig: async (_machineId: string, config: LodyAgentConfigRow, signal?: AbortSignal) => {
      const response = await runtime.requestMachineAcpCapabilitiesRefresh(
        {
          type: "machine/acp-capabilities-refresh",
          machineId,
          workspaceId: runtime.workspaceId,
          configId: config.id,
        },
        signal === undefined ? {} : { signal },
      );
      if (response?.success !== true) {
        throw new Error(response?.error ?? "ACP capability refresh did not return a response");
      }
      // NOT `requireRemoteSync: true`, which is what upstream's own pass asks
      // for. "Remote" there means the CLOUD plane, and `syncMode: 'local'`
      // never opens one — the daemon's rows arrive over the local data plane
      // instead, so the flag would make every refresh throw after doing its
      // work. Measured: it did, on the first phase-3 run.
      await resyncMachineFlockRows(runtime, machineId, {});
    },
    onError: (cause: unknown, context: { configId?: string }) =>
      options.onError?.(cause, context.configId),
  }, options.signal === undefined ? {} : { signal: options.signal });
}
