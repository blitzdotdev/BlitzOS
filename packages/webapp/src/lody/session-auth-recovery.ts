/**
 * What a session whose agent is signed out needs: the state, and the repair
 * (plans/LODY-RUNTIME-DESIGN.md §12.3 and §15.2).
 *
 * `sessionNeedsAgentSignIn` is what the banner in `agent-auth-notice.tsx`
 * renders on, and it is also the first of the repair's three conditions, so it
 * lives here with them rather than in the component — a pure module the
 * daemon-backed tests can import without pulling a React graph behind it.
 *
 * THE REPAIR: DROPPING AN ACP SESSION ID THAT NAMES NOTHING.
 *
 * WHAT GOES WRONG. The daemon persists `acpSessionId` on the session's doc meta
 * as soon as the adapter answers `session/new`, and BEFORE it sends the first
 * prompt (`apps/cli/src/session/session-manager.ts:1455`). The claude adapter
 * accepts `session/new` while the CLI is signed out and refuses only at prompt
 * time, so a turn that fails `acp_auth_required` leaves behind an id for an ACP
 * session that carries no conversation and that the agent will never find again.
 *
 * The member then signs in, sends the next message, and the daemon RESUMES that
 * id: `loadSession` answers `Resource not found`, the daemon falls back to a
 * fresh ACP session with the chat history replayed into the prompt — which is
 * the "Resuming conversation from chat history" divider the member saw — and
 * that turn then ends with no agent output at all. The message after it works,
 * because by then a real ACP session exists to resume.
 *
 * WHAT THIS DOES. It removes the phantom id, so the next dispatch takes the
 * daemon's ordinary cold-restore path instead of its resume-failure fallback.
 * Nothing is lost: the id named an ACP session that never held a turn.
 *
 * WHY IT IS OURS AND NOT A VENDOR PATCH. The session document is dual-authored
 * — the browser writes the meta when it creates a session — so removing a field
 * from it is an authored write on the seam we already own, not a change to the
 * daemon. The upstream fix is different and bigger (do not persist an
 * `acpSessionId` before the ACP session has carried a turn, or clear it when a
 * resume reports the session is gone); it is recorded in
 * `vendor/lody/BLITZ-PATCHES.md` under "things upstream does not support".
 *
 * THE THREE CONDITIONS, and each is load-bearing:
 *
 * 1. The last thing that happened to this session is an `acp_auth_required`
 *    failure (`sessionNeedsAgentSignIn`). Any later assistant turn means the
 *    credential is working and the id is real.
 * 2. The session has never produced agent output. A session with a real
 *    conversation behind it has an id worth resuming, and forcing a history
 *    replay there would throw away the agent's own context.
 * 3. The session is not running. The daemon writes `acpSessionId` seconds
 *    before the first block streams, so a repair that ignored the status could
 *    delete the id of the turn that is happening right now.
 */
import { isJsonArray, isJsonObject, isJsonString, type JsonValue } from "@blitzos/schema";
import { getSessionRoomId } from "@lody/shared";
import type { LodyDocMetaSnapshot, LodyWorkspaceRuntime } from "./runtime.js";
import type { LodySessionDocState } from "./wire-types.js";

/** Lody's own reason code for "the agent CLI is not signed in"
 * (`packages/shared/src/ai.ts:1105`, ACP error -32000). */
const ACP_AUTH_REQUIRED = "acp_auth_required";

/**
 * Whether this session's history ends in an unresolved auth failure.
 *
 * The LAST `chat_failed` notice decides, not any of them: a member who signs in
 * and re-sends leaves the old notice in the transcript forever, and a banner
 * keyed on "has ever failed" would never go away. A later notice with a
 * different reason therefore clears this one, and so does a later assistant
 * turn — which is why the scan runs backwards and stops at the first history
 * entry that carries any system notice or assistant content.
 */
export function sessionNeedsAgentSignIn(state: LodySessionDocState): boolean {
  const history = state.history;
  if (history === undefined || !isJsonArray(history)) return false;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry === undefined || !isJsonObject(entry)) continue;
    const role = entry.role;
    if (role !== undefined && isJsonString(role) && role === "assistant") return false;
    const reason = chatFailedReason(entry.items);
    if (reason === null) continue;
    return reason === ACP_AUTH_REQUIRED;
  }
  return false;
}

/** The `reason` of the first `chat_failed` notice in one history entry's items,
 * or `null` when the entry carries none. */
function chatFailedReason(items: JsonValue | undefined): string | null {
  if (items === undefined || !isJsonArray(items)) return null;
  for (const item of items) {
    if (!isJsonObject(item)) continue;
    if (item.type !== "system_notice" || item.name !== "chat_failed") continue;
    const meta = item.meta;
    if (meta === undefined || !isJsonObject(meta)) return "";
    const reason = meta.reason;
    return reason !== undefined && isJsonString(reason) ? reason : "";
  }
  return null;
}

/** Status types the daemon treats as an active turn
 * (`apps/cli/src/session/session-dispatch-logic.ts:112`). */
const ACTIVE_STATUS_TYPES = new Set(["running", "initializing", "requestPermission"]);

/** `true` once any assistant entry carries content. The daemon writes the
 * assistant row with `items: []` as soon as the adapter accepts a turn, so the
 * row alone says nothing about whether the agent ever spoke. */
export function sessionProducedAgentOutput(state: LodySessionDocState): boolean {
  const history = state.history;
  if (history === undefined || !isJsonArray(history)) return false;
  return history.some((entry) => {
    if (!isJsonObject(entry) || entry.role !== "assistant") return false;
    const items = entry.items;
    return items !== undefined && isJsonArray(items) && items.length > 0;
  });
}

/** Condition 3: the daemon is between `session/new` and the first block. */
export function sessionIsActive(snapshot: LodyDocMetaSnapshot | undefined): boolean {
  const status = snapshot?.meta.status;
  if (status === undefined || !isJsonObject(status)) return false;
  const type = status.type;
  return type !== undefined && isJsonString(type) && ACTIVE_STATUS_TYPES.has(type);
}

/** The id to drop, or `null` when there is nothing to drop. */
export function phantomAcpSessionId(snapshot: LodyDocMetaSnapshot | undefined): string | null {
  const acpSessionId = snapshot?.meta.acpSessionId;
  if (acpSessionId === undefined || !isJsonString(acpSessionId) || acpSessionId === "") return null;
  return sessionIsActive(snapshot) ? null : acpSessionId;
}

/**
 * Clears the phantom id if this session has one. Returns the id it dropped.
 *
 * Idempotent, and cheap to call repeatedly: it reads the doc meta the runtime
 * already holds and writes only when all three conditions hold. Called from the
 * sign-in banner's own poll, which is the one place that already knows a
 * session is sitting on an auth failure.
 */
export async function repairPhantomAcpSession(
  runtime: LodyWorkspaceRuntime,
  sessionId: string,
): Promise<string | null> {
  const needsRepair = await runtime.withSessionStore(sessionId, (store) => {
    const state = store.getState();
    return sessionNeedsAgentSignIn(state) && !sessionProducedAgentOutput(state);
  });
  if (!needsRepair) return null;
  const roomId = getSessionRoomId(sessionId);
  const phantom = phantomAcpSessionId(await runtime.repo.getDocMeta(roomId));
  if (phantom === null) return null;
  // `undefined` is loro-repo's delete; see `LodyWorkspaceWriter.upsertDocMeta`.
  await runtime.writer.upsertDocMeta(roomId, { acpSessionId: undefined });
  return phantom;
}
