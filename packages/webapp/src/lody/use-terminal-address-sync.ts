/**
 * The terminal arm of the address, kept in step with the panes
 * (plans/LODY-TERMINAL-TABS.md §4.2, wave-3 findings F5 and S1).
 *
 * A terminal tab has TWO pieces of state and only one of them is the address.
 * The selection is `/workspaces/:id/chat[/:sessionId]/terminal/:tabId`; the
 * MOUNT is `webapp_state`'s per-pane `activeId`, which is what `CloudApp`'s
 * `renderedSessions` admits a tab body from. Phase 1 wrote the address from the
 * pane and never the other way, so three things went wrong and each of them is
 * one branch below:
 *
 * 1. **The address names a tab that is gone.** The member closed it, or a link
 *    was opened against a different document. `closeTab` has already picked the
 *    successor, so the address follows the pane's own choice; with nothing left
 *    it falls back to the host page the address named.
 * 2. **The address names a tab the pane is not showing.** A deep link, or the
 *    back button across two terminal tabs: the persisted `activeId` is some
 *    other tab, `renderedSessions` admits only that one, and the addressed tab
 *    renders EMPTY. Nothing else reconciles an address-borne id into the
 *    document — `selectTtydSession` and `appendTab` are the only writers of
 *    `withRegionActiveId`, and neither runs on a deep link.
 * 3. **The layout cannot draw the strip at all.** Below the mobile breakpoint
 *    the vendored strip is not mounted (§5.5), so a mobile visit to a terminal
 *    address rendered the chat, kept the URL naming a terminal, and drew the
 *    native strip underneath the surface where nothing could reach it.
 *
 * It lives here rather than inside `CloudApp.tsx` for the reason CLAUDE.md
 * gives: that file is over the 700-line warn and is split on touch.
 */
import { useEffect } from "react";
import { tabRegion, type WorkspaceTab } from "../storage.js";

export interface TerminalAddressSyncOptions {
  /** `CloudApp`'s `surfaceTabsEnabled`: the strip exists and draws our tabs. */
  enabled: boolean;
  /** Below the mobile breakpoint, where no vendored strip is mounted. */
  mobile: boolean;
  /** `true` once the workspace's persisted document has been read. */
  tabsLoaded: boolean;
  tabs: readonly WorkspaceTab[];
  mainActiveId: number | null;
  sideActiveId: number | null;
  /** The workspace tab the address names, or `null`. */
  terminalId: string | null;
  /** The session that tab's strip is drawn in, or `null` on the landing. */
  sessionId: string | null;
  /** Make the addressed tab the active one in its own pane, so its body
   * mounts. Answers `false` when the workspace no longer holds it. */
  focusPaneTab: (terminalId: string) => boolean;
  openTerminal: (terminalId: string) => void;
  openSession: (sessionId: string) => void;
  openLanding: () => void;
  closeChat: (options?: { replace?: boolean }) => void;
}

export function useTerminalAddressSync(options: TerminalAddressSyncOptions): void {
  const {
    enabled,
    mobile,
    tabsLoaded,
    tabs,
    mainActiveId,
    sideActiveId,
    terminalId,
    sessionId,
    focusPaneTab,
    openTerminal,
    openSession,
    openLanding,
    closeChat,
  } = options;

  // MOBILE: THE ADDRESS NAMES A TAB NOTHING ON THIS LAYOUT CAN DRAW (F5).
  //
  // The chat surface covers the panes whenever the address is in the chat
  // plane, and on mobile it contributes no host tabs — so the terminal the URL
  // named was unreachable and the native strip that could have reached it was
  // drawn behind the surface.
  //
  // THE TERMINAL WINS, NOT THE SESSION. Two answers were available: drop the
  // terminal arm and show the conversation, or close the chat surface and let
  // the panes show the terminal. The second one is what a member on the desktop
  // was already looking at when the window narrowed, and it is what a mobile
  // terminal click already does (`selectWorkspaceTab` calls `closeChat` there),
  // so it keeps the screen and the rule the same. Replaces rather than pushes:
  // a pushed correction makes the back button land on the address that is about
  // to be corrected again.
  useEffect(() => {
    if (!mobile || !tabsLoaded || terminalId === null) return;
    focusPaneTab(terminalId);
    closeChat({ replace: true });
  }, [closeChat, focusPaneTab, mobile, tabsLoaded, terminalId]);

  // DESKTOP: THE ADDRESS AND THE DOCUMENT DISAGREE (F2's neighbour, S1).
  useEffect(() => {
    if (!enabled || !tabsLoaded || terminalId === null) return;
    const tab = tabs.find((entry) => String(entry.id) === terminalId);
    if (tab === undefined) {
      // (1) Gone. The pane already chose a successor; follow it, and fall back
      // to the host page the address named when there is nothing left.
      if (mainActiveId !== null) openTerminal(String(mainActiveId));
      else if (sessionId !== null) openSession(sessionId);
      else openLanding();
      return;
    }
    // (2) Open, but not the tab its own pane is showing — so its body is not
    // mounted and the strip draws a selected tab over an empty pane.
    const active = tabRegion(tab) === "main" ? mainActiveId : sideActiveId;
    if (active === tab.id) return;
    focusPaneTab(terminalId);
  }, [
    enabled,
    focusPaneTab,
    mainActiveId,
    openLanding,
    openSession,
    openTerminal,
    sessionId,
    sideActiveId,
    tabs,
    tabsLoaded,
    terminalId,
  ]);
}
