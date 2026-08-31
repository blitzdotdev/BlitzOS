/**
 * What `CloudApp` needs to drive the rail's vendored zone, in one hook
 * (plans/LODY-SESSIONS.md §8, phase 4 items D and F).
 *
 * It lives here rather than inside `CloudApp.tsx` for the reason CLAUDE.md
 * gives: that file is over the 700-line warn and is split on touch, never
 * grown. Everything below is Lody-specific, so this is the seam.
 *
 * THREE THINGS.
 *
 * 1. The rail's PORTAL HOST. `SessionRail` hands its `div.session-list` over
 *    through a ref; `SessionSurface` portals Lody's sidebar body into it. The
 *    host is React state and not a ref, because the surface has to re-render
 *    when it arrives.
 * 2. NAVIGATION. Chat selection is an address (`ChatAddress`), so opening a
 *    session is a `pushState` plus a route update — the same two lines every
 *    other navigation in `CloudApp` is. Nothing about chat sessions is written
 *    to `webapp_state`: the daemon's session list is the source of truth for
 *    which sessions exist, and the URL is where the active selection lives.
 *
 *    EVERY RAIL INTERACTION COMES THROUGH HERE, and that is not a style
 *    preference. `openSession` and `openLanding` are handed to the vendored
 *    sidebar (`SessionSurface` → `LodyRailBinding`), because the surface's own
 *    router cannot take the view back from the panes: with `chat === null` the
 *    surface is hidden, `mirror` is deliberately inert, and a navigation inside
 *    a hidden surface is invisible. Routing a rail click through the surface
 *    was the third canary dogfood's first three reports, all one defect.
 * 3. The FRESH-WORKSPACE DEFAULT (§0.4). With the flag on, a workspace whose
 *    persisted document holds no tabs opens the chat landing instead of the
 *    panes. `defaultWorkspaceTabs()` is what makes a fresh workspace hold none
 *    (`storage.ts`), so the two halves of the rule live one function apart.
 *    Once per workspace id, and with `replaceState`, so the back button is not
 *    given a step the member never took, and a member who deliberately closed
 *    the landing is not sent back to it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppRoute, ChatAddress } from "../sessions-page-state.js";
import {
  workspaceChatPath,
  workspacePath,
  workspaceSharedChatPath,
} from "../sessions-page-state.js";
import { LODY_SESSIONS_ENABLED } from "./flag.js";

export interface LodyRailState {
  /** `true` while the chat surface should cover the panes. */
  visible: boolean;
  /** The session the address names on the grantee's OWN box, or `null` on the
   * landing, on the panes, or while a shared session is open. */
  sessionId: string | null;
  /** The address the whole chat surface is at, shared or not. Read by
   * `useSharedSessions` to decide which owner's box to mount. */
  chat: ChatAddress;
  /** Handed to `ShellNav` as `onVendorHost`, and `null` with the flag off so
   * the rail keeps its native list. */
  onVendorHost: ((node: HTMLDivElement | null) => void) | undefined;
  /** Handed to `LodySessionsRegion`. */
  railHost: HTMLElement | null;
  openLanding: () => void;
  openSession: (sessionId: string) => void;
  /** One session another member shared, on that member's machine. */
  openSharedSession: (ownerMembershipId: string, sessionId: string) => void;
  /** The other direction: the surface navigated itself — the landing's send
   * creates a session and goes to it — so the address follows. Compares before
   * it acts, which is what keeps it from looping against the effect that drives
   * the surface FROM the address. */
  mirror: (sessionId: string | null) => void;
  /** Called when a terminal row is clicked: the panes take the view back. */
  closeChat: () => void;
}

export function useLodyRail(
  route: AppRoute,
  setRoute: (route: AppRoute) => void,
  activeWorkspaceId: string,
  /** `true` once the workspace's persisted document has been read. */
  tabsLoaded: boolean,
  /** How many tabs that document holds. Zero is the fresh-workspace signal. */
  tabCount: number,
): LodyRailState {
  const [railHost, setRailHost] = useState<HTMLElement | null>(null);
  const chat: ChatAddress = route.page === "webApp" ? route.chat : null;

  const go = useCallback(
    (path: string, next: ChatAddress) => {
      if (activeWorkspaceId === "") return;
      // Already there. A rail row is clickable while it is the open one, so
      // without this every second click on it pushes a history entry that
      // navigates nowhere and costs the member a press of the back button.
      if (window.location.pathname === path) return;
      window.history.pushState({}, "", path);
      setRoute({ workspaceId: activeWorkspaceId, page: "webApp", chat: next });
    },
    [activeWorkspaceId, setRoute],
  );

  const openLanding = useCallback(
    () => go(workspaceChatPath(activeWorkspaceId), "landing"),
    [activeWorkspaceId, go],
  );
  const openSession = useCallback(
    (sessionId: string) => go(workspaceChatPath(activeWorkspaceId, sessionId), { sessionId }),
    [activeWorkspaceId, go],
  );
  const openSharedSession = useCallback(
    (ownerMembershipId: string, sessionId: string) =>
      go(workspaceSharedChatPath(activeWorkspaceId, ownerMembershipId, sessionId), {
        sessionId,
        sharedFrom: ownerMembershipId,
      }),
    [activeWorkspaceId, go],
  );
  const mirror = useCallback(
    (sessionId: string | null) => {
      // `chat === null` means the panes own the view; a background navigation
      // inside the hidden surface must not yank it back. Nor may a shared
      // session's address be overwritten by the OWN surface's router, which
      // keeps navigating in the background while it is hidden.
      if (!LODY_SESSIONS_ENABLED || chat === null) return;
      if (chat !== "landing" && chat.sharedFrom !== undefined) return;
      if (sessionId === null) {
        if (chat !== "landing") openLanding();
        return;
      }
      if (chat === "landing" || chat.sessionId !== sessionId) openSession(sessionId);
    },
    [chat, openLanding, openSession],
  );

  const closeChat = useCallback(() => {
    if (chat === null) return;
    go(workspacePath(activeWorkspaceId), null);
  }, [activeWorkspaceId, chat, go]);

  // §0.4, once per workspace. `defaulted` is a ref rather than state because a
  // second pass must not re-run the effect that set it.
  const defaulted = useRef(new Set<string>());
  useEffect(() => {
    if (!LODY_SESSIONS_ENABLED) return;
    if (route.page !== "webApp" || activeWorkspaceId === "" || !tabsLoaded) return;
    if (defaulted.current.has(activeWorkspaceId)) return;
    defaulted.current.add(activeWorkspaceId);
    if (route.chat !== null || tabCount > 0) return;
    window.history.replaceState({}, "", workspaceChatPath(activeWorkspaceId));
    setRoute({ workspaceId: activeWorkspaceId, page: "webApp", chat: "landing" });
  }, [activeWorkspaceId, route, setRoute, tabCount, tabsLoaded]);

  return {
    visible: LODY_SESSIONS_ENABLED && chat !== null,
    // A shared session is NOT this surface's address: it is mounted against
    // another box, by a second surface, so the own surface stays where it was.
    sessionId:
      chat === null || chat === "landing" || chat.sharedFrom !== undefined
        ? null
        : chat.sessionId,
    chat,
    onVendorHost: LODY_SESSIONS_ENABLED ? setRailHost : undefined,
    railHost,
    openLanding,
    openSession,
    openSharedSession,
    mirror,
    closeChat,
  };
}
