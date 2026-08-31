/**
 * What directory a session's agent works in, decided on our side.
 *
 * TWO DEFAULTS, ONE SUBJECT. The first is the worktree pill's initial value for
 * a REPO-BACKED session (`seedWorktreeWorkdirDefault`). The second is the
 * working directory of a PLAIN CHAT — a session started with no repo picked —
 * which upstream leaves in the daemon's own chat-storage directory and which
 * this module moves to the box's `/workspace`.
 *
 * ---------------------------------------------------------------------------
 * 1. The worktree pill's default, seeded rather than forced
 * (plans/LODY-SESSIONS.md §0.5, plans/LODY-RUNTIME-DESIGN.md §10.3).
 *
 * Upstream renders the pill `checked disabled` only in the `github` context —
 * the bare-mirror source BlitzOS does not use. A BlitzOS worktree session is the
 * `local` context, where the pill is a real toggle whose initial value comes from
 * `readWorkdirModePreference` (`lib/workdir-mode-preferences.ts:12`): the
 * per-project key first, then the global one, then `'local'`. And `'local'` means
 * the agent edits the `/workspace/<repo>` clone in place, which is not the
 * default this product wants.
 *
 * §0.5's ruling is to seed their own store instead of patching the component, so
 * this writes the GLOBAL key — the one upstream only ever reads, never writes —
 * and only when it is absent. That leaves both overrides intact: their own
 * per-project write (which is what ticking the pill off does) still wins, and a
 * member who sets the global key by hand is not overwritten on the next mount.
 */
import { FILES_DAV_ROOT } from "../resolver.js";
import { isJsonObject, isJsonString, type JsonObject, type JsonValue } from "@blitzos/schema";
import { sendProjectControl, type LodyHttpPlaneEndpoints } from "./rpc-client.js";
import type { LodyWorkspaceRuntime, LodyWorkspaceWriter } from "./runtime.js";
import type { LodyProjectRef } from "./session.js";

/** `GLOBAL_WORKDIR_MODE_KEY` (`lib/workdir-mode-preferences.ts:4`). Inlined
 * rather than imported: it is not exported upstream. */
const GLOBAL_WORKDIR_MODE_KEY = "lody.workdirMode.global";

/** What a repo-backed session should default to. */
const WORKTREE_MODE = "worktree";

/** Writes the default once. Returns what the store holds afterwards, so a test
 * can assert the seed without reaching into `localStorage` itself. */
export function seedWorktreeWorkdirDefault(
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): string | null {
  try {
    const stored = storage.getItem(GLOBAL_WORKDIR_MODE_KEY);
    if (stored !== null) return stored;
    storage.setItem(GLOBAL_WORKDIR_MODE_KEY, WORKTREE_MODE);
    return WORKTREE_MODE;
  } catch {
    // Sandboxed storage. Their reader falls back to `'local'` for this mount,
    // which is the honest degradation: nothing is broken, the pill starts off.
    return null;
  }
}

/**
 * 2. A PLAIN CHAT SESSION STARTS IN `/workspace`.
 *
 * THE BUG, measured against `lody@0.88.1` on a canary box. A session started
 * from the landing with no repo picked carries no `ProjectRef`, and a session
 * with no `ProjectRef` is given no working directory:
 *
 *     const workdir =
 *       project?.kind === 'local'
 *         ? ((await this.resolveLocalProjectWorkdirForTurn(...)) ?? undefined)
 *         : undefined;                    // session-execution-service.ts:4141
 *
 * That `undefined` reaches `Session.getWorkdir()`, whose else-branch is
 * `ensureDefaultSessionWorkdir(sessionId)` (`session/session.ts:175`) —
 * `<dataDir>/chats/<sessionId>` (`:64`), i.e. `/var/lib/blitz/lody/chats/<id>`
 * on a box. So the agent runs in an empty scratch directory and reports the
 * workspace as empty, which is the first half of what the member sees.
 *
 * The second half is the file viewer. A relative path from chat output is
 * joined to the SESSION'S working directory and nothing else —
 * `path.resolve(workspaceRoot, expanded)`
 * (`lib/file-preview/file-preview-path-policy.ts:160`), where `workspaceRoot`
 * is `session.getHostWorkdir() ?? session.getWorkdir()`
 * (`lib/message-handler.ts:6125`), falling back to the session doc's
 * `project` when no session is live (`:6238`). So `CLAUDE.md` resolves under
 * the chats directory, finds nothing, and the viewer says "File not found".
 *
 * And an ABSOLUTE chip is no better, for a reason one step earlier: before a
 * turn there is no live session to read a workdir off, and with no `project`
 * in the session document the resolver runs out of answers and returns
 * `workspace_unavailable` (`:6355`) — which the viewer renders as "Session has
 * no local project or GitHub repository workspace". The Files tab and All
 * Changes hang off the same resolution and fail with it. One cause, all four.
 *
 * WHY THE FIX IS A `ProjectRef` AND NOT A WORKDIR FIELD. There is no workdir
 * field to send: `SessionCreateRequestSchema` is `.strict()` and carries none
 * (`message-schemas.ts:531`), and `SessionMeta` has none either. `project` is
 * the daemon's only client-settable input to that decision. A `local`
 * `ProjectRef` with `useWorktree` absent means "run in the project's own
 * directory" — exactly the semantics wanted — and `/workspace` is registered
 * as a local project the same way the box's registrar registers each clone
 * (`packages/box/rootfs/usr/local/libexec/blitz-lody-projects`), through
 * `local-project/add`, which normalizes the path and needs no git repository
 * (`lib/local-project-control-service.ts:1299`).
 *
 * WHAT IT DOES NOT CHANGE. No `githubRepoFullName` and no `branch` are set, so
 * `resolveProjectGitHubRepo` stays undefined (`shared/src/project.ts:164`) and
 * the session is still a Chat to the rail (`loro-app-sidebar.tsx:1600` groups
 * on `repoFullName`), still not a worktree (`session-manager.ts:1837` needs
 * `useWorktree === true`), and still skips the branch preparation that would
 * refuse a non-git directory (`session-execution-service.ts:4358` runs only
 * `if (branch)`). A session that already HAS a project — every worktree
 * session — is passed through untouched.
 */

/** `/workspace` on the box, which is also the root dufs serves. */
const DEFAULT_SESSION_WORKDIR = FILES_DAV_ROOT;

/**
 * Registers the box's workspace root as a Lody local project and returns the
 * `ProjectRef` a plain session should carry, or `null` when the daemon refused.
 *
 * `local-project/add` is idempotent on `rootPath` — the same path always
 * answers with the same `localProjectId` — so repeating this costs one POST and
 * changes nothing, which is the same property the box registrar relies on.
 */
async function resolveDefaultSessionProject(
  endpoints: LodyHttpPlaneEndpoints,
  machineId: string,
  rootPath: string = DEFAULT_SESSION_WORKDIR,
): Promise<LodyProjectRef | null> {
  const response = await sendProjectControl(endpoints, {
    type: "local-project/add",
    machineId,
    rootPath,
  });
  if (!response.ok) return null;
  const localProjectId = localProjectIdOf(response.result);
  if (localProjectId === null) return null;
  return { kind: "local", localProjectId };
}

/** `localProjectId` off a `local-project/add` result (`lody-fleet.ts:1805`). */
function localProjectIdOf(result: JsonValue): string | null {
  if (!isJsonObject(result)) return null;
  const id = result.localProjectId;
  if (id === undefined || !isJsonString(id) || id === "") return null;
  return id;
}

/**
 * Resolves the default project once, and keeps trying until it succeeds.
 *
 * Only a SUCCESS is memoized. A daemon that has not provisioned its implicit
 * workspace yet refuses `local-project/add`, and caching that refusal would
 * leave every session of the browser tab's lifetime in the chats directory.
 */
export function createDefaultSessionProjectResolver(
  endpoints: LodyHttpPlaneEndpoints,
  machineId: string,
  rootPath?: string,
): () => Promise<LodyProjectRef | null> {
  let resolved: LodyProjectRef | null = null;
  let inFlight: Promise<LodyProjectRef | null> | null = null;
  return async () => {
    if (resolved !== null) return resolved;
    inFlight ??= resolveDefaultSessionProject(endpoints, machineId, rootPath).finally(() => {
      inFlight = null;
    });
    resolved = await inFlight;
    return resolved;
  };
}

/**
 * The writer that gives a projectless session its default project.
 *
 * `startSession` is the one write that creates a session on the product path —
 * the landing's send calls it through `useSessionActions`
 * (`hooks/use-session-actions.ts:663`) and its `meta` is the whole accept unit,
 * so `project` written here reaches the daemon's dispatch watcher
 * (`session-dispatch-watcher.ts:1990`) with the session's first turn rather
 * than in a follow-up patch it could race.
 *
 * A DECORATOR RATHER THAN A VENDOR PATCH, and rather than seeding the landing's
 * repo picker: seeding the picker would show `/workspace` as a selected
 * repository and hand it to the worktree pill, which would then try to cut a
 * worktree from a directory that is not a git repository. This says the one
 * true thing instead — a chat with no repo works in the workspace — and says it
 * where nothing else can read it as a repo selection.
 *
 * The spread is safe because `createDirectWorkspaceWriter`
 * (`providers/workspace-writer-impl.ts:34`) returns a plain object of closures,
 * not a class instance: every method it carries beyond this seam's five keeps
 * working through the copy.
 */
export function withDefaultSessionProject(
  writer: LodyWorkspaceWriter,
  resolveProject: () => Promise<LodyProjectRef | null>,
): LodyWorkspaceWriter {
  return {
    ...writer,
    startSession: async (sessionId, meta, entry, dispatch) => {
      await writer.startSession(sessionId, await withDefaultProject(meta, resolveProject), entry, dispatch);
    },
  };
}

/** Every runtime this module has already decorated. A set rather than a field on
 * the object because `LodyWorkspaceRuntime` is the vendored shape and nothing
 * ours belongs on it. */
const decoratedRuntimes = new WeakSet<LodyWorkspaceRuntime>();

/**
 * The same default, applied to a runtime somebody else created.
 *
 * `RuntimeProvider` is what builds the runtime on the product path
 * (`providers/runtime-provider.tsx:311` writes `runtimeAtom`), so the writer
 * cannot be decorated at construction there — it is decorated after, by
 * swapping the atom's value for this copy. Its init effect neither reads the
 * atom back nor disposes through it (`:341` disposes its own local), so the
 * swap is invisible to it.
 *
 * IDEMPOTENT, because the caller is a subscriber to the atom it writes: a
 * runtime that came back from here is returned unchanged, which is what ends
 * the loop.
 */
export function applyDefaultSessionProject(
  runtime: LodyWorkspaceRuntime,
  resolveProject: () => Promise<LodyProjectRef | null>,
): LodyWorkspaceRuntime {
  if (decoratedRuntimes.has(runtime)) return runtime;
  // `createWorkspaceRuntime` returns a plain object of closures
  // (`create-workspace-runtime.ts:4577`), so the copy carries every member it
  // has — `mutatePreviewVisualComments` and the rest of the writer included.
  const next: LodyWorkspaceRuntime = {
    ...runtime,
    writer: withDefaultSessionProject(runtime.writer, resolveProject),
  };
  decoratedRuntimes.add(next);
  return next;
}

/**
 * `meta` with a `project`, or `meta` unchanged.
 *
 * Unchanged in two cases, and both matter: a session that already picked a
 * project (every worktree session) must keep it, and a daemon that refused the
 * registration must leave the session exactly as upstream would have written
 * it — a chat in the chats directory is a worse session, but a session with a
 * `localProjectId` the daemon cannot resolve is a FAILED one
 * (`session-execution-service.ts:3320`).
 */
async function withDefaultProject(
  meta: JsonObject,
  resolveProject: () => Promise<LodyProjectRef | null>,
): Promise<JsonObject> {
  if (meta.project !== undefined) return meta;
  const project = await resolveProject();
  if (project === null) return meta;
  return { ...meta, project: { ...project } };
}
