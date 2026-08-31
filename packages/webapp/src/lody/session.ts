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

/** The arguments `buildInitialHistoryEntry` takes, narrowed to the ones this
 * package supplies (`vendor/lody/packages/shared/src/session-bootstrap.ts:16`).
 * Named on our side because every `@lody/*` export is a namespace across the
 * vendor type seam (`wire-types.ts`). */
interface LodyInitialHistoryEntryArgs {
  userId: string;
  timestamp: string;
  cliType: string;
  agentType: string;
  prompt: string;
  inputBlocks: undefined;
  modeId?: string;
}

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
   * The permission mode this session's first turn runs under.
   *
   * Absent means the agent's own default, which for claude is `auto` — a mode
   * whose classifier answers permission prompts on the member's behalf
   * (`shared/src/ai.ts:402`). `'default'` is the one their UI calls Manual, and
   * it is what makes a permission request reach a human at all. In the product
   * the composer's permission selector supplies it; a caller without a composer
   * has to say it here or inherit `auto` silently.
   */
  modeId?: string;
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

/** One pending user turn, built by Lody's own builder. Shared by the first turn
 * and every turn after it — their builder mints a fresh id per call and knows
 * nothing about which turn of a session this is. */
function buildUserTurn(input: {
  userId: string;
  agentType: string;
  prompt: string;
  /** Explicitly `| undefined` rather than optional, so both callers can pass
   * their own optional field straight through. */
  modeId: string | undefined;
  timestamp: string;
}) {
  const entryArgs: LodyInitialHistoryEntryArgs = {
    userId: input.userId,
    timestamp: input.timestamp,
    cliType: "builtin",
    agentType: input.agentType,
    prompt: input.prompt,
    inputBlocks: undefined,
  };
  if (input.modeId !== undefined) entryArgs.modeId = input.modeId;
  // SAFETY: `buildInitialHistoryEntry` returns Lody's `SessionHistoryInput | null`;
  // the seam erases that to an untyped value, and `builderObject` re-checks that
  // what arrived is an object before any field is read.
  const built = buildInitialHistoryEntry(entryArgs) as JsonValue;
  if (built === null) throw new LodySessionStartError("lody_session_empty_prompt");
  const entry = builderObject(built, "history entry");
  return {
    entry,
    userTurnId: builderString(entry.id, "user turn id"),
    inputConfig: builderObject(entry.inputConfig ?? null, "input config"),
  };
}

export async function startLodySession(
  runtime: LodyWorkspaceRuntime,
  input: StartLodySessionInput,
): Promise<StartedLodySession> {
  const timestamp = new Date().toISOString();
  const { entry, userTurnId, inputConfig } = buildUserTurn({
    userId: input.userId,
    agentType: input.agentType,
    prompt: input.prompt,
    modeId: input.modeId,
    timestamp,
  });

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

/** One more user turn on a session that already exists. */
export interface ContinueLodySessionInput {
  sessionId: string;
  userId: string;
  agentType: string;
  prompt: string;
  modeId?: string;
}

/**
 * The composer's SECOND message, without React.
 *
 * `startLodySession` is the landing's send; this is every send after it. The
 * accept unit is the same shape one level down — `appendSessionTurn` writes the
 * pending user entry and the dispatch pointer in one transaction
 * (`workspace-writer.ts:55`), where `startSession` also writes the meta — so the
 * result is a `StartedLodySession` and `dispatchLodyTurn` takes it unchanged.
 *
 * It exists because a session's SECOND turn is a different code path on the
 * daemon: the first turn creates the ACP session, and every turn after it either
 * resumes that one or, when there is none to resume, replays the chat history
 * into a fresh one. `plans/LODY-RUNTIME-DESIGN.md` §14.2 is what needed to drive
 * that from a test, and nothing else in this package can.
 */
export async function continueLodySession(
  runtime: LodyWorkspaceRuntime,
  input: ContinueLodySessionInput,
): Promise<StartedLodySession> {
  const timestamp = new Date().toISOString();
  const { entry, userTurnId, inputConfig } = buildUserTurn({
    userId: input.userId,
    agentType: input.agentType,
    prompt: input.prompt,
    modeId: input.modeId,
    timestamp,
  });
  const roomId = getSessionRoomId(input.sessionId);
  await runtime.ensureDocStream(roomId);
  await runtime.writer.appendSessionTurn(input.sessionId, entry, {
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
