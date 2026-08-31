/**
 * What a BlitzOS box says when an agent turn comes back "Authentication
 * required" (plans/LODY-RUNTIME-DESIGN.md §12.3, corrected in §13.4).
 *
 * WHAT THIS BANNER IS FOR. Lody renders that failure inside the transcript and
 * puts an `AcpAuthenticationPanel` beside it (`components/ai-gui/view.tsx:2373`)
 * — but only on the entry that failed, which a member has usually scrolled past
 * by the time they read the message. This is a BAND above the chat that says the
 * same thing where it can be seen, and it carries the SAME panel so the fix is
 * one click from the notice.
 *
 * WHAT THE FIRST VERSION GOT WRONG (canary dogfood 2). It told members to
 * connect Claude in the workspace Connections panel. There is no Claude card in
 * that catalog and there never was: `blitz-cred get claude` mints from
 * harness-credential ROAMING, which copies a credential that some box already
 * has because somebody signed in on it interactively. So the panel that opened
 * had nothing in it to click, and the one instruction the banner gave could not
 * be followed. Both real routes are named here instead:
 *
 * 1. Lody's own sign-in, rendered below. It asks the daemon to run
 *    `claude auth login --claudeai` against the SAME binary the agent runs
 *    (`runtimeOverrides.claudeCodeExecutable`), streams the authorization URL
 *    back, and accepts the pasted code.
 * 2. `claude` in a terminal tab, which is the same login by hand and stores the
 *    same box credential.
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
import { runtimeAtom } from "@lody/components/atoms/runtime";
import { AcpAuthenticationPanel } from "@lody/components/components/settings/acp-authentication-panel";
import { BLITZ_CLAUDE_CONFIG_ID, BLITZ_CLAUDE_EXECUTABLE } from "./agent-configs.js";
import {
  repairPhantomAcpSession,
  sessionNeedsAgentSignIn,
} from "./session-auth-recovery.js";
import type { LodyAtomStore, LodyWorkspaceRuntime } from "./runtime.js";
import type { LodySessionDocState } from "./wire-types.js";

/** Slow on purpose; see the module comment. */
export const AUTH_NOTICE_POLL_MS = 2_000;

export interface LodyAgentAuthNoticeProps {
  store: LodyAtomStore;
  /** The session the surface is showing, or `null` on the chat landing. */
  sessionId: string | null;
  /** The box's machineId, from `/lody/platform`. The sign-in panel addresses a
   * machine and the browser cannot mint the id. Absent leaves the banner as an
   * explanation with the terminal route and no button. */
  machineId?: string;
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
  const { store, sessionId, machineId } = props;
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
      // The same poll, and deliberately not a second one: this repair fires on
      // exactly the state the banner is watching for, and it has to happen
      // BEFORE the member's next message rather than when they click sign-in —
      // signing in through a terminal tab is the other product route and
      // touches nothing of ours (§15.2).
      void repairPhantomAcpSession(runtime, sessionId).catch(() => {
        // Same two reasons as above. A phantom id that survives costs the
        // member one retry, which is the behaviour without this repair.
      });
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
        Sign in once and this box keeps the credential; every agent start after that picks it
        up. Then send the message again.
      </p>
      {machineId !== undefined && (
        <div className="lody-surface__auth-notice-panel">
          {/* Lody's own panel, unmodified. It opens a window on the authorization
              URL the daemon streams back and takes the pasted code. The overrides
              are what point the login at the box's `claude`, so the sign-in and
              the agent are the same binary. */}
          <AcpAuthenticationPanel
            machineId={machineId}
            configId={BLITZ_CLAUDE_CONFIG_ID}
            cliType="builtin"
            agentType="claude"
            runtimeOverrides={{ claudeCodeExecutable: BLITZ_CLAUDE_EXECUTABLE }}
            compact
          />
        </div>
      )}
      <p className="lody-surface__auth-notice-hint">
        Or run <code>claude</code> in a terminal tab and sign in there — it stores the same box
        credential.
      </p>
      <div className="lody-surface__auth-notice-actions">
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
