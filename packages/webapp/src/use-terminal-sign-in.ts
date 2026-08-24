import { useEffect, useRef, useState, type RefObject } from 'react';
import type { WorkspaceRole } from '@blitzos/schema';
import type { Agent } from './protocol';
import type { WorkspaceTab } from './storage';
import {
  driveTerminalSignIn,
  TERMINAL_SIGN_IN_WARMUP_MS,
} from './terminal-sign-in';

/** Terminal panes the shell has mounted at least once and now keeps alive.
 *
 * A pane that has been visited is already attached to its pty, so the login
 * command can be typed at it immediately; one that has not needs the warm-up.
 */
export interface RetainedTerminalSessions {
  workspaceId: string;
  ids: Set<string>;
}

/** Everything this orchestration needs from the shell around it.
 *
 * Named and passed in rather than closed over, so the hook can be driven
 * directly by a test and so the shell keeps exactly one line of sign-in code.
 */
export interface TerminalSignInShell {
  workspaceId: string;
  /** The active workspace's tabs, or null while they are still loading. */
  tabs: WorkspaceTab[] | null;
  accessRole: WorkspaceRole | null | undefined;
  /** The selected pane's id, as the tab strip spells it. */
  ttydActiveId: string | null;
  retainedSessions: RefObject<RetainedTerminalSessions>;
  selectSession: (sessionId: string) => void;
  /** Creates a shared session and returns its durable terminal key. */
  spawnSession: (type: Agent) => Promise<string | null>;
}

interface PendingTerminalSignIn {
  sessionKey: string;
  warmupMs: number;
}

/**
 * Drives a harness's terminal tab into its login flow.
 *
 * The caller has learned that the box cannot authenticate that harness. The
 * returned callback takes the reader to wherever its sign-in actually happens.
 *
 * No caller today: the surface that reported the failure is gone. The hook and
 * `terminal-sign-in.ts` are kept because the delivery semantics they encode
 * (warm-up, separate submit write) are the ones any future caller needs.
 *
 * For Claude, it creates or selects its terminal tab and queues the TUI's
 * login command. Codex gets a fresh terminal tab instead: the box launcher
 * decides whether a device-code sign-in is needed and runs it before starting
 * the Codex TUI, which works when the browser and CLI are on different
 * machines.
 *
 * The request has to survive a render, which is why it is state rather than a
 * straight call: only the selected pane consumes terminal input, and a pane
 * that has never been visited is not even mounted, so the keystrokes wait here
 * until React has committed the tab switch.
 */
export function useTerminalSignIn(shell: TerminalSignInShell): (provider: Agent) => void {
  const {
    workspaceId,
    tabs,
    accessRole,
    ttydActiveId,
    retainedSessions,
    selectSession,
    spawnSession,
  } = shell;
  const [pending, setPending] = useState<PendingTerminalSignIn | null>(null);
  // Whether the pane this request is aimed at has ever actually been selected.
  // A ref, not state: flipping it must not itself re-run the driving effect,
  // which would restart the warm-up it is in the middle of.
  const arrivedRef = useRef(false);

  // A workspace switch unmounts every pane, so a request aimed at one of them
  // can never be honoured; the ids in it belong to the workspace being left.
  useEffect(() => {
    arrivedRef.current = false;
    setPending(null);
  }, [workspaceId]);

  useEffect(() => {
    if (pending === null) return;
    const target = tabs?.find((tab) => (
      tab.type === 'file' || tab.type === 'preview' || tab.type === 'panel'
        ? false
        : (tab.sessionId ?? String(tab.id)) === pending.sessionKey
    ));
    if (target === undefined) return;
    const targetTabId = String(target.id);
    if (ttydActiveId !== targetTabId) {
      // Two different situations reach here, and only one of them is a
      // cancellation. BEFORE the tab switch commits, the target pane is simply
      // not selected yet — that is the whole reason this is state, so the
      // request must survive. AFTER it has been selected once, the reader has
      // moved somewhere else, which cancels the request outright; the cleanup
      // below already stopped the timers, and dropping the state is what stops
      // it re-arming. Without this, returning to the tab an hour later types
      // `/login` and Enter into a live agent TUI mid-session.
      if (
        arrivedRef.current
        || (
          retainedSessions.current.workspaceId === workspaceId
          && retainedSessions.current.ids.has(targetTabId)
        )
      ) setPending(null);
      return;
    }
    arrivedRef.current = true;
    return driveTerminalSignIn(
      pending.sessionKey,
      pending.warmupMs,
      () => setPending(null),
    );
  }, [pending, tabs, ttydActiveId]);

  return (provider: Agent) => {
    if (tabs === null || accessRole === 'viewer') return;
    if (provider === 'codex') {
      // Never type `/login` into Codex here. Its default browser flow redirects
      // to localhost on the reader's computer, while the CLI listener lives on
      // the remote box. A new tmux session runs blitz-codex-session, which owns
      // the supported device-code flow before starting the Codex TUI.
      //
      // ALWAYS A FRESH SESSION, deliberately: the launcher decides about
      // sign-in once, at session start, so selecting a codex tab that is
      // already past that point would do nothing at all. The cost is that
      // repeated clicks open repeated tabs; the launcher's own probes mean a
      // tab only reaches a device prompt on a box that is genuinely signed
      // out, so the pile-up needs a real failure to trigger.
      //
      // Nothing is queued for this provider, so `pending` stays null and the
      // driving effect never runs — do not add an arrivedRef reset here.
      setPending(null);
      spawnSession(provider);
      return;
    }
    const existing = tabs.find((session) => session.type === provider);
    if (existing) {
      const tabId = String(existing.id);
      const sessionKey = ('sessionId' in existing ? existing.sessionId : undefined) ?? tabId;
      selectSession(tabId);
      const mounted = retainedSessions.current.workspaceId === workspaceId
        && retainedSessions.current.ids.has(tabId);
      arrivedRef.current = false;
      setPending({ sessionKey, warmupMs: mounted ? 0 : TERMINAL_SIGN_IN_WARMUP_MS });
      return;
    }
    // Session creation crosses the control plane. The tab appears after the
    // server supplies its durable key; the effect above then finds the local
    // tab id and waits for React to select/mount it before typing `/login`.
    void spawnSession(provider).then((sessionKey) => {
      if (sessionKey === null) return;
      arrivedRef.current = false;
      setPending({ sessionKey, warmupMs: TERMINAL_SIGN_IN_WARMUP_MS });
    });
  };
}
