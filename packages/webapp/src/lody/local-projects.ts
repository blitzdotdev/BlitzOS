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
import { isJsonArray, isJsonObject, isJsonString, type JsonObject, type JsonValue } from "@blitzos/schema";
import {
  getMachineFlockDocId,
  getMachineFlockLocalProjects,
  getMachineRoomId,
  readMachineFlockRowsFromFlock,
} from "@lody/shared";
import { setWorkspaceReposCacheAtom } from "@lody/components/atoms/local-storage-cache";
import { sendProjectControl, type LodyHttpPlaneEndpoints } from "./rpc-client.js";
import type { LodyAtomStore, LodyWorkspaceRuntime } from "./runtime.js";

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

/**
 * Publishing the box's repos as the workspace's "connected GitHub repositories".
 *
 * THE THIRD COUPLING PHASE 5 FOUND, and the one that silently defeats §6.4.
 * `chat-landing.tsx:481` will only put `githubRepoFullName` on a session's
 * `ProjectRef` when the name the daemon derived from the clone's remote ALSO
 * appears in `repositories` — the workspace's cloud-connected GitHub repo list:
 *
 *     return workspaceRepositories?.some((repo) => repo.fullName === repoFullName)
 *       ? repoFullName
 *       : null;
 *
 * This composition has no cloud, so that list is empty and the field is always
 * dropped. Everything downstream then reads the session as a plain chat: the
 * rail groups it under Chats instead of GitHub Worktrees, and — the expensive
 * one — turn post-processing skips `updateSessionDiffStats` entirely, because
 * upstream gates it on `resolveProjectGitHubRepo(project)` being truthy
 * (`session-execution-service.ts:2351`). Measured on a live turn: the agent
 * edited the worktree, the turn finalized, and no diff stats were ever computed.
 *
 * `repositories` is `freshRepositories ?? cachedRepositories`, and the cached
 * half is a writable jotai atom. So the fix is to say the true thing: the repos
 * this workspace is connected to are the clones on its box. Each one's name is
 * the daemon's own answer to `local-project/git-state`, so nothing is invented
 * here — a clone with no GitHub remote contributes nothing and its sessions stay
 * in Chats, which is the honest reading.
 */
export async function publishBoxReposAsWorkspaceRepos(
  store: LodyAtomStore,
  endpoints: LodyHttpPlaneEndpoints,
  runtime: LodyWorkspaceRuntime,
  machineId: string,
): Promise<string[]> {
  const listed = await sendProjectControl(endpoints, {
    type: "local-project/list",
    machineId,
  });
  if (!listed.ok) return [];
  const projects = localProjectRows(listed.result);

  const repositories: { fullName: string }[] = [];
  for (const project of projects) {
    const state = await sendProjectControl(endpoints, {
      type: "local-project/git-state",
      machineId,
      workspaceId: runtime.workspaceId,
      localProjectId: project.localProjectId,
    });
    if (!state.ok) continue;
    const fullName = repoFullNameOf(state.result);
    if (fullName !== null) repositories.push({ fullName });
  }
  if (repositories.length === 0) return [];

  store.set(setWorkspaceReposCacheAtom, { workspaceId: runtime.workspaceId, repositories });
  return repositories.map((repository) => repository.fullName);
}

/** The `local-project/list` result, narrowed to the one field this file reads. */
function localProjectRows(result: JsonValue): { localProjectId: string }[] {
  if (!isJsonObject(result)) return [];
  const workspaces = result.workspaces;
  if (workspaces === undefined || !isJsonArray(workspaces)) return [];
  const rows: { localProjectId: string }[] = [];
  for (const workspace of workspaces) {
    if (!isJsonObject(workspace)) continue;
    const projects = workspace.projects;
    if (projects === undefined || !isJsonArray(projects)) continue;
    for (const project of projects) {
      if (!isJsonObject(project)) continue;
      const id = project.localProjectId;
      if (id !== undefined && isJsonString(id)) rows.push({ localProjectId: id });
    }
  }
  return rows;
}

/** `githubRepoFullName` off a `local-project/git-state` result, or `null` for a
 * clone with no GitHub remote (and for `{ git: false }`). */
function repoFullNameOf(result: JsonValue): string | null {
  if (!isJsonObject(result)) return null;
  const fullName = result.githubRepoFullName;
  if (fullName === undefined || !isJsonString(fullName) || fullName === "") return null;
  return fullName;
}
