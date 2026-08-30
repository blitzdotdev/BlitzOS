/**
 * What a BlitzOS box says when an agent turn comes back "Authentication
 * required" (plans/LODY-RUNTIME-DESIGN.md §12.3).
 *
 * WHY OURS AND NOT THEIRS. Lody already renders that failure, and it already
 * renders a Retry button beside it (`components/ai-gui/view.tsx:2373` →
 * `AcpAuthenticationPanel`). But the ACTION behind that button is Lody's
 * desktop answer: it asks the daemon to run `claude auth login --claudeai` and
 * drives an interactive CLI login on the machine. On a box that is the wrong
 * answer and cannot be the right one — nobody is sitting at the box, and the
 * box's Claude credential is not a thing a member types in. It is MINTED, per
 * process start, by `/usr/local/bin/claude` calling `blitz-cred-claude`
 * against the workspace's connected Claude account.
 *
 * So the honest message names the credential the box actually uses and the one
 * place a member can supply it. It layers ON TOP of the vendor notice rather
 * than replacing it: zero vendor edits, and their Retry keeps working for the
 * cases where an interactive login IS what somebody wants.
 *
 * WHY IT POLLS. The signal is a durable history item in the session's Loro doc
 * (`apps/cli/src/lib/message-handler.ts:1687` writes
 * `{ type: 'system_notice', name: 'chat_failed', meta: { reason } }`), not
 * reducer state and not an atom — there is no `authRequired` selector anywhere
 * in the renderer to subscribe to. `withSessionStore` is a borrow with a
 * refcount released in its own `finally`, so holding a `subscribe` across it
 * would outlive the lease it was taken under. A read every
 * `AUTH_NOTICE_POLL_MS` costs one map over the open document, the session page
 * already holds that document open, and the notice is terminal for the turn —
 * so latency is the only thing being traded, and only in seconds.
 */
import { useEffect, useState } from "react";
import { isJsonArray, isJsonObject, isJsonString, type JsonValue } from "@blitzos/schema";
import { runtimeAtom } from "@lody/components/atoms/runtime";
import type { LodyAtomStore, LodyWorkspaceRuntime } from "./runtime.js";
import type { LodySessionDocState } from "./wire-types.js";

/** The provider name `blitz connections open` knows, and the one the panel
 * highlights. Lower-case because that is the connection NAME, not a title. */
export const CLAUDE_CONNECTION_NAME = "claude";

/** Lody's own reason code for "the agent CLI is not signed in"
 * (`packages/shared/src/ai.ts:1105`, ACP error -32000). */
const ACP_AUTH_REQUIRED = "acp_auth_required";

/** Slow on purpose; see the module comment. */
export const AUTH_NOTICE_POLL_MS = 2_000;

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

export interface LodyAgentAuthNoticeProps {
  store: LodyAtomStore;
  /** The session the surface is showing, or `null` on the chat landing. */
  sessionId: string | null;
  /** Opens the workspace connections panel with `provider` selected. Absent
   * leaves the banner as an explanation with no button — which is still better
   * than the vendor panel's "Missing workspace context" was. */
  onOpenConnections?: (provider: string) => void;
}

/** Reads the session doc on a timer and reports whether the agent is signed
 * out. Exported for the test, which drives it without a DOM. */
export async function readAgentSignInState(
  runtime: LodyWorkspaceRuntime,
  sessionId: string,
): Promise<boolean> {
  return await runtime.withSessionStore(sessionId, (sessionStore) =>
    sessionNeedsAgentSignIn(sessionStore.getState()),
  );
}

export function LodyAgentAuthNotice(props: LodyAgentAuthNoticeProps) {
  const { store, sessionId, onOpenConnections } = props;
  const [signedOut, setSignedOut] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // A dismissal belongs to the session it was made in. Re-arming on every
  // session change is what stops "I read that already" on one session from
  // hiding the same failure on the next one.
  useEffect(() => {
    setDismissed(false);
    setSignedOut(false);
  }, [sessionId]);

  useEffect(() => {
    if (sessionId === null) return undefined;
    let disposed = false;
    const poll = (): void => {
      const runtime = store.get<LodyWorkspaceRuntime | null>(runtimeAtom);
      if (runtime === null) return;
      void readAgentSignInState(runtime, sessionId).then(
        (needsSignIn) => {
          if (!disposed) setSignedOut(needsSignIn);
        },
        () => {
          // A session whose document is not open yet, or a runtime disposed
          // between the read and its answer. The next tick asks again.
        },
      );
    };
    poll();
    const timer = window.setInterval(poll, AUTH_NOTICE_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [store, sessionId]);

  if (!signedOut || dismissed) return null;
  return (
    <div className="lody-surface__auth-notice" role="alert">
      <p className="lody-surface__auth-notice-title">Claude is not signed in on this box</p>
      <p>
        Agents on a Blitz box sign in with a token minted from your workspace&rsquo;s Claude
        connection. Connect Claude, then send the message again. Each agent start mints a
        fresh token, so no restart is necessary.
      </p>
      <div className="lody-surface__auth-notice-actions">
        {onOpenConnections !== undefined && (
          <button
            type="button"
            className="lody-surface__auth-notice-button"
            onClick={() => onOpenConnections(CLAUDE_CONNECTION_NAME)}
          >
            Open connections
          </button>
        )}
        <button
          type="button"
          className="lody-surface__auth-notice-dismiss"
          onClick={() => setDismissed(true)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
