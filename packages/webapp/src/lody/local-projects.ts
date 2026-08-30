/**
 * Making a worktree session ARCHIVABLE (plans/LODY-SESSIONS.md §0.5).
 *
 * THE UPSTREAM BUG, measured against `lody@0.88.1` on 2026-08-30.
 *
 * Archiving a session removes its worktree and, if the tree is dirty, commits a
 * backup first. To find the worktree the daemon has to resolve the local
 * project's `originalRootPath`, and `resolveWorktreeCleanupTarget`
 * (`apps/cli/src/lib/message-handler.ts:4315`) reads it out of ONE map:
 *
 *     const localProjects = {
 *       ...(machineMeta?.localProjects ?? {}),
 *       ...getMachineFlockLocalProjects(options.machineFlockRows ?? {}),
 *     };
 *
 * The DELETE path passes `machineFlockRows` (`:4499`). **The ARCHIVE path does
 * not** (`:3971`, and the same asymmetry is in the shipped bundle at
 * `dist/index.js:169066` / `:169476`). And `local-project/add` — the only way a
 * BlitzOS box registers a repo (§6.4) — writes the FLOCK row and never the
 * legacy `machineMeta.localProjects` field (`lody-fleet.ts:1552`
 * → `upsertMachineLocalProject`, `lib/local-project-meta.ts:76`).
 *
 * So on a box the archive path resolves `originalRootPath` to nothing, returns
 * `null`, and the worktree is left on disk with the member's uncommitted work
 * in it and no backup commit. Upstream's own renderer compensates for the
 * DELETE path by merging the Flock rows into the delete command
 * (`use-session-actions.ts:1313`); nothing compensates for archive.
 *
 * THE FIX, AND WHY IT IS NOT A VENDOR PATCH. The legacy field is still READ by
 * both paths, so writing it is enough. This mirrors the Flock rows the daemon
 * already wrote into `machineMeta.localProjects`, once per runtime, from
 * outside `vendor/`. Every reader merges legacy-then-Flock, so a mirrored entry
 * can only agree with the Flock row it came from — and `removeMachineLocalProject`
 * (`local-project-meta.ts:106`) already clears the legacy field when a project
 * is removed, so nothing here resurrects a deleted project.
 *
 * DELETE THIS when upstream passes `machineFlockRows` on the archive path. The
 * upstream change is four lines and is the right fix; this is the one a host
 * can ship without forking the daemon.
 */
import { isJsonObject, type JsonObject, type JsonValue } from "@blitzos/schema";
import {
  getMachineFlockDocId,
  getMachineFlockLocalProjects,
  getMachineRoomId,
  readMachineFlockRowsFromFlock,
} from "@lody/shared";
import type { LodyWorkspaceRuntime } from "./runtime.js";

/**
 * Copies the machine's `localProject` Flock rows into `machineMeta.localProjects`.
 *
 * Returns the project ids it mirrored. Idempotent: the write is a whole-map
 * upsert of what the Flock already says, so repeating it changes nothing.
 */
export async function mirrorLocalProjectsToMachineMeta(
  runtime: LodyWorkspaceRuntime,
  machineId: string,
): Promise<string[]> {
  const flockDocId: string = getMachineFlockDocId(runtime.workspaceId, machineId);
  const handle = await runtime.repo.openFlockDoc(flockDocId);
  await handle.syncOnce().catch(() => {
    // The local mirror is the fallback, exactly as in `agent-configs.ts`: a room
    // that has not exchanged state yet converges later, and the next mount
    // repeats this pass.
  });

  // SAFETY: `readMachineFlockRowsFromFlock` and `getMachineFlockLocalProjects`
  // are Lody's own reader and parser for this row family; the vendor type seam
  // erases their return types, and the shape is re-checked below before use.
  const projects = getMachineFlockLocalProjects(
    readMachineFlockRowsFromFlock(handle.flock, { families: ["localProject"] }),
  ) as JsonValue;
  if (!isJsonObject(projects)) return [];
  const ids = Object.keys(projects);
  if (ids.length === 0) return [];

  const patch: JsonObject = { localProjects: projects };
  await runtime.writer.upsertDocMeta(getMachineRoomId(machineId), patch);
  return ids;
}
