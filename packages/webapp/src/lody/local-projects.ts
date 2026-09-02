/**
 * The box's repositories, as the renderer needs to see them.
 *
 * Three passes, run in order when the surface mounts (`agent-config-gate.tsx`):
 * `registerWorkspaceRepositories` makes sure each `/workspace/<repo>` is a Lody
 * local project, `mirrorLocalProjectsToMachineMeta` publishes the set to the one
 * field the project picker and the daemon's archive path both read, and
 * `publishBoxReposAsWorkspaceRepos` says which of them are GitHub clones.
 *
 * ---------------------------------------------------------------------------
 * 1. Making a worktree session ARCHIVABLE (plans/LODY-SESSIONS.md §0.5).
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
import { FILES_DAV_ROOT } from "../resolver.js";
import { setWorkspaceReposCacheAtom } from "@lody/components/atoms/local-storage-cache";
import { sendProjectControl, type LodyHttpPlaneEndpoints } from "./rpc-client.js";
import type { LodyAtomStore, LodyDocMetaSnapshot, LodyWorkspaceRuntime } from "./runtime.js";
import type { LodyProjectControlRequest } from "./wire-types.js";

/**
 * Copies the machine's `localProject` Flock rows into `machineMeta.localProjects`.
 *
 * Returns the project ids the field holds afterwards.
 *
 * IT IS ALSO WHAT THE PROJECT PICKER READS, which is the second reason this
 * function exists and the reason it merges. `buildVisibleLocalProjectIndex`
 * (`lib/visible-local-project-index.ts:69`) walks `machine.localProjects` and
 * NOTHING ELSE — not the Flock, not `local-project/list`. So on a box every row
 * the registrar writes reaches the composer's "Select a project" list through
 * this one write, and a pass that wrote LESS than the previous one took repos
 * off the list.
 *
 * A whole-map replace could do exactly that. `syncOnce` above is best-effort:
 * a room that has not finished exchanging state answers with the rows it has so
 * far, and a box holds ~20 of them. Merging the field's current value under the
 * Flock's rows makes a short read a no-op instead of a deletion.
 *
 * MERGING CANNOT RESURRECT A REMOVED PROJECT. `removeMachineLocalProject`
 * (`local-project-meta.ts:129`) deletes the WHOLE legacy field — not one key —
 * once the Flock row is gone, so the value merged under a later read is either
 * absent or a map the daemon still agrees with.
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

  const machineRoomId = getMachineRoomId(machineId);
  const merged: JsonObject = { ...mirroredLocalProjects(await runtime.repo.getDocMeta(machineRoomId)), ...projects };
  const ids = Object.keys(merged);
  if (ids.length === 0) return [];

  const patch: JsonObject = { localProjects: merged };
  await runtime.writer.upsertDocMeta(machineRoomId, patch);
  return ids;
}

/** What `machineMeta.localProjects` already holds, or an empty map for a room
 * the repo has never seen and for a field the daemon has cleared. */
function mirroredLocalProjects(snapshot: LodyDocMetaSnapshot | undefined): JsonObject {
  if (snapshot === undefined || snapshot.deleted) return {};
  const current = snapshot.meta.localProjects;
  if (current === undefined || !isJsonObject(current)) return {};
  return current;
}

/**
 * Registering the box's repos from the TAB, as well as from the box.
 *
 * `blitz-lody-projects` on the box is the durable half of §6.4 and stays the
 * one that runs with no browser open. But it cannot be the only half:
 *
 * - It skips every pass until the daemon has written `workspace-catalog.json`,
 *   then polls every 30 s. A member who opens the surface inside that window
 *   gets a picker missing whatever the registrar has not reached yet, and
 *   nothing re-reads it until the tab is reloaded.
 * - It ships in the box IMAGE. A box created from an image that predates it has
 *   no registrar at all, and no deploy can give it one.
 *
 * This is the same registration through the same door, driven when the surface
 * mounts. `local-project/browse-dir` is the daemon's own directory listing —
 * `hints.git` is `.git` EXISTING, file or directory, so a worktree checkout
 * counts (`local-project-control-service.ts:352`), hidden entries are already
 * excluded, and `registeredProjectId` is filled in for a path the workspace
 * already holds. So the sweep adds exactly the repos that are missing.
 *
 * Returns the root paths it registered. `local-project/add` is idempotent on
 * `rootPath`, so a redundant add — a repo the registrar reached first, between
 * the browse and the add — costs one POST and changes nothing.
 */
export async function registerWorkspaceRepositories(
  endpoints: LodyHttpPlaneEndpoints,
  machineId: string,
  workspaceId: string,
  workspaceRoot: string = FILES_DAV_ROOT,
): Promise<string[]> {
  const added: string[] = [];
  let cursor: string | undefined;
  // The daemon pages at 500 entries by default, so `/workspace` is one call and
  // the loop is the honest reading of `truncated` rather than a hot path. The
  // bound is what keeps a daemon that answers a cursor pointing at itself from
  // spinning the tab.
  for (let page = 0; page < MAX_BROWSE_PAGES; page += 1) {
    // Built without a conditional spread, so an absent cursor is an absent
    // property: `LocalProjectBrowseDirRequestSchema` is `.strict()` and a
    // `cursor: undefined` key is a 400 from the daemon.
    const request: LodyProjectControlRequest = {
      type: "local-project/browse-dir",
      machineId,
      workspaceId,
      absolutePath: workspaceRoot,
    };
    if (cursor !== undefined) request.cursor = cursor;
    const listed = await sendProjectControl(endpoints, request);
    if (!listed.ok) return added;
    const browsed = browseDirPage(listed.result);
    for (const rootPath of browsed.unregisteredRepositories) {
      const response = await sendProjectControl(endpoints, {
        type: "local-project/add",
        machineId,
        rootPath,
      });
      if (response.ok) added.push(rootPath);
    }
    if (browsed.nextCursor === null) return added;
    cursor = browsed.nextCursor;
  }
  return added;
}

/** Enough pages to cover a workspace of 5 000 directories at the daemon's own
 * default page size. */
const MAX_BROWSE_PAGES = 10;

/** One `local-project/browse-dir` page, narrowed to what the sweep acts on. */
export interface BrowseDirPage {
  /** Every entry the daemon hinted as a git repository that the workspace does
   * not already hold, by absolute path. */
  unregisteredRepositories: string[];
  /** The cursor for the next page, or `null` when this one was the last. */
  nextCursor: string | null;
}

/**
 * Reads one page.
 *
 * An entry is a repository to register when the daemon hinted `git`, did not
 * report it unreadable, and did not already resolve it to a project. Anything
 * else — a plain directory, a directory the daemon could not open — is left
 * alone rather than guessed at.
 */
export function browseDirPage(result: JsonValue): BrowseDirPage {
  if (!isJsonObject(result)) return { unregisteredRepositories: [], nextCursor: null };
  const entries = result.entries;
  const unregisteredRepositories: string[] = [];
  if (entries !== undefined && isJsonArray(entries)) {
    for (const entry of entries) {
      if (!isJsonObject(entry)) continue;
      if (entry.error !== undefined || entry.registeredProjectId !== undefined) continue;
      const hints = entry.hints;
      if (hints === undefined || !isJsonObject(hints) || hints.git !== true) continue;
      const absolutePath = entry.absolutePath;
      if (absolutePath !== undefined && isJsonString(absolutePath)) {
        unregisteredRepositories.push(absolutePath);
      }
    }
  }
  const nextCursor = result.nextCursor;
  return {
    unregisteredRepositories,
    nextCursor:
      result.truncated === true && nextCursor !== undefined && isJsonString(nextCursor)
        ? nextCursor
        : null,
  };
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
 *
 * THE SWEEP IS ALSO A PROBE, and `gitProbe` is its second answer. The landing
 * disables its send button whenever a local project is selected in worktree
 * mode and the project's git-state load errs (`getChatLandingSubmitDisabled`,
 * `chat-landing-derived.ts`) — and worktree mode is OUR default, seeded by
 * `workdir-default.ts`. So the seed must not land on a box whose daemon cannot
 * actually answer git-state: this sweep already asks the exact question for
 * every registered project, and the verdict says whether every project
 * answered and at least one is a git repository the worktree default could
 * apply to. `agent-config-gate.tsx` seeds on `"verified"` and nothing else.
 */
export type LocalProjectGitProbe =
  /** Every registered project answered `git-state`, and at least one is a git
   * repository — the worktree default is meaningful and known to load. */
  | "verified"
  /** Every probe answered, but no project is a git repository (a fresh box, or
   * only the `/workspace` root project). Nothing to conclude; ask again on the
   * next mount. */
  | "no-git-project"
  /** The list or any git-state call was refused — the state the landing's own
   * loader would turn into a permanent error under a worktree default. */
  | "unanswered";

export interface BoxRepoPublication {
  /** The GitHub full names published to the workspace-repos cache. */
  publishedFullNames: string[];
  gitProbe: LocalProjectGitProbe;
}

export async function publishBoxReposAsWorkspaceRepos(
  store: LodyAtomStore,
  endpoints: LodyHttpPlaneEndpoints,
  runtime: LodyWorkspaceRuntime,
  machineId: string,
): Promise<BoxRepoPublication> {
  const listed = await sendProjectControl(endpoints, {
    type: "local-project/list",
    machineId,
  });
  if (!listed.ok) return { publishedFullNames: [], gitProbe: "unanswered" };
  const projects = localProjectRows(listed.result);

  let gitProbe: LocalProjectGitProbe = "no-git-project";
  const repositories: { fullName: string }[] = [];
  for (const project of projects) {
    const lookup = await readLocalProjectRepoFullName(
      endpoints,
      machineId,
      runtime.workspaceId,
      project.localProjectId,
    );
    if (!lookup.answered) {
      // One refused probe poisons the verdict for good: the landing may
      // auto-select exactly this project, so "the box answers git-state" has
      // to hold for every project, not just one.
      gitProbe = "unanswered";
      continue;
    }
    if (gitProbe === "no-git-project" && lookup.git) gitProbe = "verified";
    if (lookup.repoFullName === null) continue;
    repositories.push({ fullName: lookup.repoFullName });
  }
  if (repositories.length === 0) return { publishedFullNames: [], gitProbe };

  store.set(setWorkspaceReposCacheAtom, { workspaceId: runtime.workspaceId, repositories });
  return { publishedFullNames: repositories.map((repository) => repository.fullName), gitProbe };
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

/**
 * What the daemon said about ONE local project's GitHub remote.
 *
 * THREE STATES, NOT TWO, and the third is the one a caller must not collapse. A
 * daemon that refused the call has said nothing — the clone may well have a
 * remote — while a daemon that answered `{ git: false }` or a clone with no
 * GitHub origin has answered "no name", and that answer will not change on the
 * next try. `workdir-default.ts` memoizes on exactly this distinction.
 */
export type LocalProjectRepoLookup =
  | { answered: true; repoFullName: string | null; git: boolean }
  | { answered: false };

/**
 * `owner/repo` for one registered clone, straight from the daemon.
 *
 * The daemon derives it from the clone's own remote, so this is the only
 * authority a box has for the name — and, unlike the landing's own resolution,
 * it is not filtered through a cloud-connected repository list that a box can
 * never fill (see `publishBoxReposAsWorkspaceRepos` below).
 */
export async function readLocalProjectRepoFullName(
  endpoints: LodyHttpPlaneEndpoints,
  machineId: string,
  workspaceId: string,
  localProjectId: string,
): Promise<LocalProjectRepoLookup> {
  const state = await sendProjectControl(endpoints, {
    type: "local-project/git-state",
    machineId,
    workspaceId,
    localProjectId,
  });
  if (!state.ok) return { answered: false };
  return { answered: true, repoFullName: repoFullNameOf(state.result), git: isGitRepository(state.result) };
}

/** Whether a `local-project/git-state` result names a git repository. `git` is
 * the daemon's own verdict: `true` for any repository, remote or not, and
 * `false` for a registered plain directory such as the `/workspace` root. */
function isGitRepository(result: JsonValue): boolean {
  return isJsonObject(result) && result.git === true;
}

/** `githubRepoFullName` off a `local-project/git-state` result, or `null` for a
 * clone with no GitHub remote (and for `{ git: false }`). */
function repoFullNameOf(result: JsonValue): string | null {
  if (!isJsonObject(result)) return null;
  const fullName = result.githubRepoFullName;
  if (fullName === undefined || !isJsonString(fullName) || fullName === "") return null;
  return fullName;
}
