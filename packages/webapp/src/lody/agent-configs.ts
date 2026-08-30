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
 * from Lody's R2 channel (`packages/platform/src/runtime-artifacts.ts`) — the
 * exact thing the image's `DISABLE_AUTOUPDATER` pin exists to prevent
 * everywhere else. With one, `apps/cli/src/agent/setting.ts:441` short-circuits
 * that path entirely and spawns our binary.
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
import { cmdCreateAgentConfigAtom, getAgentConfigsByMachineAtomFamily } from "@lody/components/atoms/agents";
import type { LodyAtomStore } from "./runtime.js";

/** The shim, not `/opt/blitz/npm/bin/claude`; see the module comment. */
export const BLITZ_CLAUDE_EXECUTABLE = "/usr/local/bin/claude";
export const BLITZ_CODEX_PATH = "/usr/local/bin/codex";

/** Stable ids. `blitz-` prefixed so they never collide with the uuid the
 * settings dialog mints, which is what makes the bootstrap idempotent. */
export const BLITZ_CLAUDE_CONFIG_ID = "blitz-claude";
export const BLITZ_CODEX_CONFIG_ID = "blitz-codex";

/** An agent-config row as `parseAgentConfigRaw` (`atoms/agents.ts:148`) accepts
 * it. `description` is a required KEY that may hold `undefined`; `env` must be
 * present and must stay empty. */
export interface LodyAgentConfigRow {
  id: string;
  machineId: string;
  name: string;
  description: string | undefined;
  cliType: "builtin";
  agentType: string;
  env: Record<string, string>;
  runtimeOverrides: { claudeCodeExecutable?: string; codexPath?: string };
}

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
      description: undefined,
      cliType: "builtin",
      agentType: "claude",
      env: {},
      runtimeOverrides: { claudeCodeExecutable: BLITZ_CLAUDE_EXECUTABLE },
    },
    {
      id: BLITZ_CODEX_CONFIG_ID,
      machineId,
      name: "Codex",
      description: undefined,
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
 * Idempotent on config id: an id already present in the merged agent-config map
 * is left alone, so a member who renamed "Claude Code" keeps the name.
 *
 * The residual race is bounded and points the safe way. The map is fed by the
 * machine Flock room, so a bootstrap that runs before that room finishes its
 * first sync sees no rows and re-writes ours. That write is an LWW put of the
 * canonical row — same id, same override — so the only thing it can undo is a
 * member's edit to a row, and the thing it re-asserts is the override that keeps
 * the daemon from downloading its own agent binary. Losing a rename is
 * recoverable; losing the override is a second unpinned CLI on the box.
 *
 * TODO(lody-phase3): once the surface can await the machine Flock room's first
 * sync, gate this on that instead, and drop to `writer.flockRowPutIfAbsent`.
 */
export async function bootstrapLodyAgentConfigs(
  store: LodyAtomStore,
  machineId: string,
): Promise<string[]> {
  const existing = store.get<{ id: string }[]>(getAgentConfigsByMachineAtomFamily(machineId));
  const present = new Set(existing.map((config) => config.id));
  const created: string[] = [];
  for (const row of blitzAgentConfigRows(machineId)) {
    if (present.has(row.id)) continue;
    await store.set(cmdCreateAgentConfigAtom, row);
    created.push(row.id);
  }
  return created;
}
