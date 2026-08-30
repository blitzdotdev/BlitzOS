/**
 * Creating a session and dispatching its first turn, without React.
 *
 * `useSessionActions` (`vendor/lody/packages/components/src/hooks/use-session-actions.ts:532`)
 * is the product path and phase 3 mounts it. It is a hook, and it also carries
 * cloud concerns this composition has none of — a PostHog capture, a Convex
 * billing quota, a workspace-activity recorder. What is left when those are
 * removed is small, and it is what the phase-2 exit test drives:
 *
 * 1. Build the session meta and the first user turn with Lody's OWN builders
 *    (`@lody/shared/session-bootstrap`), so the shapes cannot drift from theirs.
 * 2. Write both as ONE accept unit through `runtime.writer.startSession`. A
 *    promoted session must not exist before its first message is locally
 *    durable.
 * 3. Ask the machine to dispatch. That call is ACCELERATION on top of a durable
 *    pointer, never the delivery mechanism: `latestUserMsgId` in the session's
 *    doc meta is what the daemon's dispatch watcher reads, so a dropped RPC
 *    delays a turn rather than losing it.
 */
import { isJsonObject, isJsonString, type JsonObject, type JsonValue } from "@blitzos/schema";
import { getServerNow, getSessionRoomId } from "@lody/shared";
import { buildInitialHistoryEntry, buildInitialSessionMetaPatch } from "@lody/shared/session-bootstrap";
import type { LodyWorkspaceRuntime } from "./runtime.js";

export interface StartLodySessionInput {
  /** Caller-chosen so the room id is known before the write lands. */
  sessionId: string;
  machineId: string;
  /** The daemon's `local:<uuid>`, from `/lody/platform`. Its access oracle
   * allows exactly this id (`vendor/lody/packages/platform/src/local.ts:103`),
   * so a BlitzOS membership id here is refused at dispatch. */
  userId: string;
  /** `'blitz-claude'` / `'blitz-codex'`; see `agent-configs.ts`. */
  agentConfigId: string;
  agentType: string;
  prompt: string;
  title?: string;
  /**
   * The session's `ProjectRef`, for a worktree session (plan §6.4).
   *
   * It belongs in the ACCEPT UNIT and not in a follow-up patch, because the
   * daemon reads it off session meta on three separate paths: the dispatch
   * watcher decides whether to cut a worktree from it, the removal preflight
   * filters on `project.localProjectId` (`local-project-removal.ts:23`), and
   * turn post-processing gates diff stats on `resolveProjectGitHubRepo(project)`
   * (`session-execution-service.ts:2351`). A session that existed for a moment
   * without it would be a chat session to all three.
   *
   * Absent for a plain chat, which is what a session with no project is.
   */
  project?: LodyProjectRef;
}

/**
 * `ProjectRefSchema`'s `local` member (`message-schemas.ts:510`), stated on our
 * side of the vendor type seam. `github` is not offered: §0's worktree v1 is
 * `local-shared` only, cut off the `/workspace/<repo>` clone the box already
 * has, so nothing here ever asks the daemon to mirror a remote.
 */
export type LodyProjectRef = {
  kind: "local";
  localProjectId: string;
  /** The base branch the worktree is cut from. */
  branch?: string;
  /** Derived by the daemon from the clone's remote and reported on
   * `local-project/git-state`; copied here so the rail groups the session under
   * GitHub Worktrees and so diff stats run. */
  githubRepoFullName?: string;
  useWorktree?: boolean;
};

export interface StartedLodySession {
  sessionId: string;
  roomId: string;
  userTurnId: string;
  timestamp: string;
  inputConfig: JsonObject;
}

export class LodySessionStartError extends Error {}

/** Narrows one of Lody's own builder results across the vendor type seam, where
 * every `@lody/*` export is untyped. */
function builderObject(value: JsonValue, what: string): JsonObject {
  if (!isJsonObject(value)) throw new LodySessionStartError(`lody builder produced no ${what}`);
  return value;
}

function builderString(value: JsonValue | undefined, what: string): string {
  if (value === undefined || !isJsonString(value) || value === "") {
    throw new LodySessionStartError(`lody builder produced no ${what}`);
  }
  return value;
}

export async function startLodySession(
  runtime: LodyWorkspaceRuntime,
  input: StartLodySessionInput,
): Promise<StartedLodySession> {
  const timestamp = new Date().toISOString();
  // SAFETY: `buildInitialHistoryEntry` returns Lody's `SessionHistoryInput | null`;
  // the seam erases that to an untyped value, and `builderObject` re-checks that
  // what arrived is an object before any field is read.
  const built = buildInitialHistoryEntry({
    userId: input.userId,
    timestamp,
    cliType: "builtin",
    agentType: input.agentType,
    prompt: input.prompt,
    inputBlocks: undefined,
  }) as JsonValue;
  if (built === null) throw new LodySessionStartError("lody_session_empty_prompt");
  const entry = builderObject(built, "history entry");
  const userTurnId = builderString(entry.id, "user turn id");
  const inputConfig = builderObject(entry.inputConfig ?? null, "input config");

  // SAFETY: `buildInitialSessionMetaPatch` returns Lody's `Partial<SessionMeta>`,
  // erased to an untyped value by the same seam; `builderObject` re-checks it.
  const patch = builderObject(
    buildInitialSessionMetaPatch({
      sessionId: input.sessionId,
      machineId: input.machineId,
      userId: input.userId,
      cliType: "builtin",
      agentType: input.agentType,
      createdAt: timestamp,
    }) as JsonValue,
    "session meta",
  );
  // `lastMessageAt` is written with the accept unit, not by a follow-up touch: a
  // close between acceptance and the first turn must never make the session look
  // empty, because an empty session is deleted rather than archived.
  const base = { ...patch, agentConfigId: input.agentConfigId, lastMessageAt: getServerNow() };
  const titled =
    input.title === undefined ? base : { ...base, title: input.title, titleSource: "user" };
  const meta = input.project === undefined ? titled : { ...titled, project: { ...input.project } };

  const roomId = getSessionRoomId(input.sessionId);
  // Pre-create the stream so the first write has somewhere to converge. Awaited
  // here rather than fired and forgotten, because the caller is a test or a
  // bootstrap, not a keystroke.
  await runtime.ensureDocStream(roomId);
  await runtime.writer.startSession(input.sessionId, meta, entry, {
    sessionId: input.sessionId,
    userTurnId,
    userId: input.userId,
    timestamp,
    inputConfig,
  });

  return { sessionId: input.sessionId, roomId, userTurnId, timestamp, inputConfig };
}

/**
 * Writes the durable dispatch pointer, then asks the machine to act on it now.
 *
 * Order matters and is the upstream order: the pointer is recovery truth, the
 * RPC is latency. Reversed, a machine that answered before the pointer landed
 * could dispatch a turn the watcher would then dispatch again.
 */
export async function dispatchLodyTurn(
  runtime: LodyWorkspaceRuntime,
  started: StartedLodySession,
  machineId: string,
  userId: string,
  options?: { timeoutMs?: number },
): Promise<JsonValue> {
  await runtime.writer.upsertDocMeta(started.roomId, { latestUserMsgId: started.userTurnId });
  return await runtime.requestSessionDispatchTurn(
    machineId,
    {
      sessionId: started.sessionId,
      userTurnId: started.userTurnId,
      userId,
      timestamp: started.timestamp,
      inputConfig: started.inputConfig,
    },
    options ?? {},
  );
}
