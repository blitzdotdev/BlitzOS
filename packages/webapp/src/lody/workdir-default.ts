/**
 * What directory a session's agent works in, decided on our side.
 *
 * THREE PARTS, ONE SUBJECT. The first is the worktree pill's initial value for
 * a REPO-BACKED session (`seedWorktreeWorkdirDefault`). The second is the
 * working directory of a PLAIN CHAT — a session started with no repo picked —
 * which upstream leaves in the daemon's own chat-storage directory and which
 * this module moves to the box's `/workspace`. The third is the same default,
 * given on OPEN to a session that was created before the second existed.
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
 *
 * SAFE WHEN GIT STATE IS UNAVAILABLE (the greyed-send finding, 2026-09-02).
 * The key is global, so no box-local probe can make the preference safe: a
 * healthy box can seed it before the same browser visits an old or temporarily
 * unreachable box. The vendored landing already computes `effectiveWorkdirMode`
 * as `'local'` when Git state is unavailable and renders the toggle off; seam
 * patch 18 makes its button and keyboard-submit gates honor that same fallback.
 * That fixes existing stored values as well as new ones while preserving the
 * worktree-first render on every healthy box.
 */
import { FILES_DAV_ROOT } from "../resolver.js";
import { isJsonObject, isJsonString, type JsonObject, type JsonValue } from "@blitzos/schema";
import { getSessionRoomId } from "@lody/shared";
import { readLocalProjectRepoFullName, type LocalProjectRepoLookup } from "./local-projects.js";
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
 * `if (branch)`). A session that is repo-backed in ANY of the three ways
 * `isPlainChatMeta` names — every worktree session — is passed through
 * untouched.
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
 * 2b. A REPO-BACKED SESSION CARRIES THE CLONE'S OWN REMOTE (RAIL-1, WT-TERM-1).
 *
 * THE BUG, reproduced 2/2 on canary. A session created against a `/workspace`
 * clone files under "Chats" instead of under its repository heading, and its
 * row's `repoFullName` is null. The rail groups on
 * `resolveProjectGitHubRepo(session.project)` (`session-list-rows.ts:283`),
 * which for a `local` ref reads `project.githubRepoFullName` — and the landing
 * only ever writes that field when the daemon's name ALSO appears in the
 * workspace's cloud-connected repository list:
 *
 *     return workspaceRepositories?.some((repo) => repo.fullName === repoFullName)
 *       ? repoFullName
 *       : null;                              // chat-landing.tsx:506
 *
 * `local-projects.ts` §3 fills that list from the box, but it fills it LATE:
 * `LodyAgentConfigGate` opens the surface as soon as the agent configs are
 * seeded and only then browses, registers, mirrors and finally publishes. A
 * member who picks a project and sends inside that window is read against an
 * empty list, the field is dropped, and the session is a Chat for good — no
 * later pass rewrites a session that already exists.
 *
 * THE FIX IS TO STOP ASKING THE CLOUD. On a box the daemon is the only
 * authority on a clone's remote, and it answers `local-project/git-state` with
 * the name directly. So a `local` ref that names a project but carries no
 * `githubRepoFullName` is completed here, at the write, from that answer.
 * Nothing is invented: a clone with no GitHub remote answers no name and its
 * sessions stay in Chats, which is the same honest degradation §3 states.
 *
 * WHY NOT JUST PUBLISH EARLIER. Moving the publish ahead of the gate would
 * narrow the window and not close it — the list is still a cache read by a
 * component that may render before it lands, and a box that registers a repo
 * later still creates Chat sessions against it. This says the true thing at the
 * one moment the value is being persisted.
 */

/** The clone's `owner/repo` for one registered local project. */
export type LocalProjectRepoResolver = (
  workspaceId: string,
  localProjectId: string,
) => Promise<LocalProjectRepoLookup>;

/**
 * The two answers a session write needs from the daemon, resolved once each.
 *
 * They travel together because every caller needs both and neither is useful
 * alone: a session is either a plain chat, which needs the `/workspace`
 * project, or it names a clone, which needs that clone's remote.
 */
export interface SessionProjectDefaults {
  /** The `/workspace` local project a plain chat runs in. */
  project: () => Promise<LodyProjectRef | null>;
  /** The GitHub remote of a clone the member picked. */
  repoFullName: LocalProjectRepoResolver;
}

/**
 * Resolves one project's repo name, and remembers only an ANSWER.
 *
 * Same rule as `createDefaultSessionProjectResolver` one level up, for the same
 * reason: a daemon that could not answer will answer later, and caching the
 * silence would leave every session of the tab's lifetime ungrouped. A daemon
 * that answered "no GitHub remote" IS an answer and is remembered — that clone
 * will not grow one while the tab is open.
 */
export function createLocalProjectRepoResolver(
  endpoints: LodyHttpPlaneEndpoints,
  machineId: string,
): LocalProjectRepoResolver {
  const answered = new Map<string, LocalProjectRepoLookup>();
  const inFlight = new Map<string, Promise<LocalProjectRepoLookup>>();
  return async (workspaceId, localProjectId) => {
    const known = answered.get(localProjectId);
    if (known !== undefined) return known;
    const running = inFlight.get(localProjectId);
    if (running !== undefined) return await running;
    const attempt = readLocalProjectRepoFullName(
      endpoints,
      machineId,
      workspaceId,
      localProjectId,
    ).finally(() => {
      inFlight.delete(localProjectId);
    });
    inFlight.set(localProjectId, attempt);
    const lookup = await attempt;
    if (lookup.answered) answered.set(localProjectId, lookup);
    return lookup;
  };
}

/** Both resolvers for one box, built together so a caller states the endpoints
 * once. */
export function createSessionProjectDefaults(
  endpoints: LodyHttpPlaneEndpoints,
  machineId: string,
  rootPath?: string,
): SessionProjectDefaults {
  return {
    project: createDefaultSessionProjectResolver(endpoints, machineId, rootPath),
    repoFullName: createLocalProjectRepoResolver(endpoints, machineId),
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
  defaults: SessionProjectDefaults,
  workspaceId: string,
): LodyWorkspaceWriter {
  return {
    ...writer,
    startSession: async (sessionId, meta, entry, dispatch) => {
      await writer.startSession(
        sessionId,
        await withCompletedProject(meta, defaults, workspaceId),
        entry,
        dispatch,
      );
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
  defaults: SessionProjectDefaults,
): LodyWorkspaceRuntime {
  if (decoratedRuntimes.has(runtime)) return runtime;
  // `createWorkspaceRuntime` returns a plain object of closures
  // (`create-workspace-runtime.ts:4577`), so the copy carries every member it
  // has — `mutatePreviewVisualComments` and the rest of the writer included.
  const next: LodyWorkspaceRuntime = {
    ...runtime,
    writer: withDefaultSessionProject(runtime.writer, defaults, runtime.workspaceId),
  };
  decoratedRuntimes.add(next);
  return next;
}

/**
 * `meta` with a `project`, or `meta` unchanged.
 *
 * Unchanged in two cases, and both matter: a session that is not a plain chat
 * must keep the directory it named, and a daemon that refused the registration
 * must leave the session exactly as upstream would have written it — a chat in
 * the chats directory is a worse session, but a session with a `localProjectId`
 * the daemon cannot resolve is a FAILED one
 * (`session-execution-service.ts:3320`).
 *
 * THE SAME THREE FIELDS §3 READS, and for the same reason. A `project` is what
 * every BlitzOS worktree session carries, so it alone was enough for the create
 * path — but `buildSessionCreateResult` writes `repoFullName` and `isWorktree`
 * from their own payload inputs (`use-session-actions.ts:159`, `:166`), so a
 * repo-backed session with no `ProjectRef` yet is a shape this seam can see.
 * Giving that one `/workspace` would point its agent at the workspace root
 * instead of letting the daemon cut it a worktree. One predicate, read twice.
 */
async function withCompletedProject(
  meta: JsonObject,
  defaults: SessionProjectDefaults,
  workspaceId: string,
): Promise<JsonObject> {
  if (isPlainChatMeta(meta)) {
    const project = await defaults.project();
    if (project === null) return meta;
    return { ...meta, project: { ...project } };
  }
  // §2b: the member picked a clone, so the one field that is missing is the
  // clone's own name. The two branches are disjoint by construction —
  // `isPlainChatMeta` is false exactly when a `project` is already there.
  const incomplete = localProjectMissingRepoName(meta);
  if (incomplete === null) return meta;
  const lookup = await defaults.repoFullName(workspaceId, incomplete.localProjectId);
  if (!lookup.answered || lookup.repoFullName === null) return meta;
  return { ...meta, project: { ...incomplete.project, githubRepoFullName: lookup.repoFullName } };
}

/**
 * A `local` `ProjectRef` that names a project and no repository, or `null`.
 *
 * `null` for every other shape, and each of them is deliberate: a ref that
 * already carries a name is what §2b would write, a `github` ref carries its
 * repository in `repoFullName` and is not this composition's anyway, and a meta
 * with no `project` at all is §2's plain chat.
 */
function localProjectMissingRepoName(
  meta: JsonObject,
): { project: JsonObject; localProjectId: string } | null {
  const project = meta.project;
  if (project === undefined || !isJsonObject(project)) return null;
  if (project.kind !== "local") return null;
  const localProjectId = project.localProjectId;
  if (localProjectId === undefined || !isJsonString(localProjectId) || localProjectId === "") {
    return null;
  }
  const existing = project.githubRepoFullName;
  if (existing !== undefined && isJsonString(existing) && existing.trim() !== "") return null;
  return { project, localProjectId };
}

/**
 * 3. A SESSION CREATED BEFORE §2 GETS THE SAME DEFAULT WHEN IT IS OPENED.
 *
 * The decorator above reaches sessions being CREATED and nothing else. A member
 * whose sessions predate it still opens each one onto "Session has no local
 * project or GitHub repository workspace", with no Files tab and no All Changes
 * — reported from canary against a box that already ran the fix. "Start a new
 * chat" is not a repair, so the same `ProjectRef` is attached the first time
 * such a session is opened.
 *
 * A PATCH ON META, WHICH CREATION COULD NOT USE. §2 writes `project` INSIDE the
 * accept unit because the daemon's dispatch watcher reads that meta with the
 * session's first turn, and a follow-up patch would race it. Here the first turn
 * is long over and there is no dispatch to race, so `upsertDocMeta` on the
 * session room is exactly right — the same field, read by the same daemon paths
 * (`message-handler.ts:6238` for the side panel,
 * `session-execution-service.ts:3312` for the next turn's workdir).
 *
 * WHAT IT CANNOT REPAIR: a RUNNING agent's working directory. The daemon fixes
 * a Session's workdir when the process starts (`session/session.ts:131`), and
 * both the next turn and the side panel prefer a live Session over the document
 * (`message-handler.ts:6179` answers from `sessionManager.getSession` before it
 * ever reads meta). So a session whose ACP process is still alive keeps the
 * chats directory until that process goes: the GC recycles it after 20 minutes
 * idle (`session-gc-manager.ts:164`), and a daemon restart ends it at once.
 * After that the restore path rebuilds the session from meta
 * (`session-execution-service.ts:3312`) and picks up `/workspace`. The panel,
 * the chips and All Changes are what the report is about, and for a session
 * nobody is mid-turn in they are fixed immediately.
 */

/**
 * What one backfill attempt decided.
 *
 * Three are FINAL — the two attachments and the meta that needed neither — and
 * three are RETRYABLE: the document may still arrive, the daemon may still
 * provision its implicit workspace, and a daemon that refused
 * `local-project/git-state` may still answer it.
 */
export type SessionProjectBackfillOutcome =
  | "attached"
  | "repo-attached"
  | "nothing-to-attach"
  | "meta-unavailable"
  | "registration-refused"
  | "repo-unavailable";

/**
 * Whether this session's meta is a plain chat's — the only kind either §2 or §3
 * gives the default project to. Declared here, beside the §3 that needs it
 * spelled out; §2 reads the same function.
 *
 * Three fields, because the create path writes each of them from a different
 * input and none implies the others (`use-session-actions.ts:159` for
 * `repoFullName`, `:163` for `project`, `:166` for `isWorktree`). `project` is
 * the one that decides the daemon's workdir, `repoFullName` is how a
 * repo-backed session that has not picked a project yet says so, and
 * `isWorktree` is what the rail and the archive path read. Any of the three
 * means this session is not a chat working in `/workspace`, and overwriting it
 * would move somebody's worktree session into the wrong directory.
 */
function isPlainChatMeta(meta: JsonObject): boolean {
  return (
    meta.project === undefined && meta.repoFullName === undefined && meta.isWorktree !== true
  );
}

/**
 * Gives one already-existing session the default project, or explains why not.
 *
 * `createdAt` IS THE PROOF THAT THE DOCUMENT HAS SYNCED, and the guard the whole
 * function rests on. A room the repo has opened but not yet filled answers an
 * empty meta, and an empty meta is indistinguishable from a plain chat's — so a
 * WORKTREE session read one tick early would be handed `/workspace` over its
 * own project. `createdAt` and `project` are written by ONE patch
 * (`session-bootstrap.ts:81`), so a meta that carries the first cannot be
 * missing the second.
 */
export async function backfillDefaultSessionProject(
  runtime: LodyWorkspaceRuntime,
  sessionId: string,
  defaults: SessionProjectDefaults,
): Promise<SessionProjectBackfillOutcome> {
  const roomId = getSessionRoomId(sessionId);
  // The same call `startLodySession` makes before it writes: the patch below
  // needs somewhere to converge, and on the local plane this is one router
  // lookup (`create-workspace-runtime.ts:3533`).
  await runtime.ensureDocStream(roomId);
  const snapshot = await runtime.repo.getDocMeta(roomId);
  if (snapshot === undefined || snapshot.deleted || snapshot.meta.createdAt === undefined) {
    return "meta-unavailable";
  }
  if (!isPlainChatMeta(snapshot.meta)) {
    return await backfillProjectRepoName(runtime, roomId, snapshot.meta, defaults);
  }
  const project = await defaults.project();
  // Unchanged on a refusal, for §2's reason: a `localProjectId` the daemon
  // cannot resolve FAILS the session's next turn.
  if (project === null) return "registration-refused";
  await runtime.writer.upsertDocMeta(roomId, { project: { ...project } });
  return "attached";
}

/**
 * §2b for a session that already exists: the repository heading it lost.
 *
 * Every session created before §2b shipped against a clone carries a `local`
 * `ProjectRef` with no `githubRepoFullName`, so it reads as a Chat in the rail
 * and the daemon skips its diff stats. The name is one `local-project/git-state`
 * away and the whole `ProjectRef` is rewritten with it — a MERGE of the existing
 * ref, never a replacement, because `branch` and `useWorktree` on it are what
 * decide the agent's directory.
 */
async function backfillProjectRepoName(
  runtime: LodyWorkspaceRuntime,
  roomId: string,
  meta: JsonObject,
  defaults: SessionProjectDefaults,
): Promise<SessionProjectBackfillOutcome> {
  const incomplete = localProjectMissingRepoName(meta);
  if (incomplete === null) return "nothing-to-attach";
  const lookup = await defaults.repoFullName(runtime.workspaceId, incomplete.localProjectId);
  if (!lookup.answered) return "repo-unavailable";
  // The daemon answered, and the clone has no GitHub remote. That is a settled
  // fact about the clone, so the session stays a Chat and nothing asks again.
  if (lookup.repoFullName === null) return "nothing-to-attach";
  await runtime.writer.upsertDocMeta(roomId, {
    project: { ...incomplete.project, githubRepoFullName: lookup.repoFullName },
  });
  return "repo-attached";
}

export type SessionProjectBackfill = (
  runtime: LodyWorkspaceRuntime,
  sessionId: string,
) => Promise<SessionProjectBackfillOutcome>;

/**
 * `backfillDefaultSessionProject`, made safe to call on every open.
 *
 * Attempts on DIFFERENT sessions are independent; attempts on the same session
 * are not. One session can be opened twice at once — a second rail click, or a
 * meta event arriving while the first attempt is still in flight — and that must
 * read once and write once, so an in-flight attempt is shared and a settled one
 * is remembered.
 *
 * Only a SETTLED decision is remembered, which is the same rule
 * `createDefaultSessionProjectResolver` follows one level down: a document that
 * had not synced yet will sync, and a daemon that refused the registration will
 * provision its workspace, so remembering either would leave the session broken
 * for the lifetime of the tab.
 */
export function createSessionProjectBackfiller(
  defaults: SessionProjectDefaults,
): SessionProjectBackfill {
  const settled = new Map<string, SessionProjectBackfillOutcome>();
  const inFlight = new Map<string, Promise<SessionProjectBackfillOutcome>>();
  return async (runtime, sessionId) => {
    const decided = settled.get(sessionId);
    if (decided !== undefined) return decided;
    const running = inFlight.get(sessionId);
    if (running !== undefined) return await running;
    const attempt = backfillDefaultSessionProject(runtime, sessionId, defaults).finally(() => {
      inFlight.delete(sessionId);
    });
    inFlight.set(sessionId, attempt);
    const outcome = await attempt;
    if (outcome === "attached" || outcome === "repo-attached" || outcome === "nothing-to-attach") {
      settled.set(sessionId, outcome);
    }
    return outcome;
  };
}
