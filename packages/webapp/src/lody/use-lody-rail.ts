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
 * 3. The WORKSPACE ROOT (§0.4, widened by the strip deletion). With the flag on
 *    and a layout that draws the session strip, `/workspaces/:id` means the chat
 *    landing. It used to mean the panes, and the panes used to carry their own
 *    tab strip; that strip is deleted (plans/LODY-TERMINAL-TABS.md §4.6), so the
 *    root address would otherwise be a workspace with no tab control. With
 *    `replaceState`, so the back button is not given a step nobody took.
 *
 * ALL THREE ARE GATED ON THE BOX, not only on the build flag
 * (`box-capability.ts`, plans/LODY-RUNTIME-DESIGN.md §17). A workspace whose
 * machine runs a pre-Lody image, and a member who holds no machine in it, get
 * the flag-off rail back and keep the panes: there is no session strip to send
 * them to, and `SessionRail`'s notice is what says so.
 */
import { useCallback, useEffect, useState } from "react";
import type { AppRoute, ChatAddress } from "../sessions-page-state.js";
import {
  chatSharedFrom,
  isChatTerminalAddress,
  workspaceChatPath,
  workspaceChatTerminalPath,
  workspacePath,
  workspaceSharedChatPath,
} from "../sessions-page-state.js";
import { lodySessionsUnavailable, type LodySessionsCapability } from "./box-capability.js";
import { LODY_SESSIONS_ENABLED } from "./flag.js";

export interface LodyRailState {
  /**
   * The build flag AND the box together: `VITE_BLITZ_LODY_SESSIONS` is on and
   * the workspace's own machine serves a session daemon.
   *
   * It is the ONE signal §4.6 of plans/LODY-TERMINAL-TABS.md gates the native
   * pane strips on. A box that cannot run the surface keeps them, which is the
   * whole flag-off experience and the correct answer for that machine.
   */
  available: boolean;
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
  /** The workspace tab the address selects in the strip, or `null` when a
   * session tab, the landing or the panes own the view. */
  terminalId: string | null;
  /** Select one workspace tab in the strip. It keeps whichever host the address
   * is already in: a session's strip stays on that session, the landing's stays
   * on the landing. */
  openTerminal: (terminalId: string) => void;
  /** The strip moved to a tab that is not a workspace tab, so the terminal arm
   * leaves the address and its HOST page stays: a session's strip falls back to
   * that session, the landing's to the landing. Inert on every other arm. */
  closeTerminal: () => void;
  /** The addressed SESSION does not exist, so the strip it hosted is gone. The
   * terminal keeps its selection and moves to the landing's strip. Inert unless
   * the address is a session-hosted terminal. */
  openTerminalOnLanding: () => void;
  /** The other direction: the surface navigated itself — the landing's send
   * creates a session and goes to it — so the address follows. Compares before
   * it acts, which is what keeps it from looping against the effect that drives
   * the surface FROM the address. */
  mirror: (sessionId: string | null) => void;
  /** Called when a terminal row is clicked: the panes take the view back.
   * `replace` for a correction the member did not ask for. */
  closeChat: (options?: { replace?: boolean }) => void;
}

/** What the active workspace's own box can do, and whether this layout can draw
 * the strip that answers for it. Both halves belong to one caller, so they
 * arrive as one argument. */
export interface LodyRailSessions {
  /** `useLodySessionsCapability` for the ACTIVE workspace's box. */
  capability: LodySessionsCapability;
  /**
   * `CloudApp`'s `surfaceTabsEnabled`: this box serves the surface AND this
   * layout draws its strip. It is what decides whether the workspace ROOT
   * address is normalised into the chat plane below — see that effect.
   */
  surfaceHostsTabs: boolean;
}

export function useLodyRail(
  route: AppRoute,
  setRoute: (route: AppRoute) => void,
  activeWorkspaceId: string,
  /** `true` once the workspace's persisted document has been read. */
  tabsLoaded: boolean,
  sessions: LodyRailSessions,
): LodyRailState {
  const [railHost, setRailHost] = useState<HTMLElement | null>(null);
  const chat: ChatAddress = route.page === "webApp" ? route.chat : null;
  const { capability, surfaceHostsTabs } = sessions;
  // `probing` keeps the vendored zone, because the probe is one round trip and
  // the chunk behind it is 3.5 MB: the rail would flicker from legacy to
  // vendored on every good box to save nothing. Only a SETTLED unavailable takes
  // the zone back — an old image or a member with no machine here, which the
  // rail treats identically because neither has a session plane to draw.
  const available = LODY_SESSIONS_ENABLED && !lodySessionsUnavailable(capability);

  const go = useCallback(
    (path: string, next: ChatAddress, options?: { replace?: boolean }) => {
      if (activeWorkspaceId === "") return;
      // Already there. A rail row is clickable while it is the open one, so
      // without this every second click on it pushes a history entry that
      // navigates nowhere and costs the member a press of the back button.
      if (window.location.pathname === path) return;
      // A CORRECTION REPLACES. Everything a member does is a push, but an
      // address the shell itself refuses — a session the daemon does not have,
      // a terminal this layout cannot draw — must not become a history entry:
      // the back button would land on it again and be bounced forward again,
      // which is a trap rather than a navigation.
      if (options?.replace === true) window.history.replaceState({}, "", path);
      else window.history.pushState({}, "", path);
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
  const openTerminal = useCallback(
    (terminalId: string) => {
      // The HOST is whichever one the address is already in. A terminal opened
      // while a session is on screen becomes a tab of that session's strip; one
      // opened from the landing becomes a tab of the landing's.
      const sessionId =
        chat === null || chat === "landing"
          ? undefined
          : isChatTerminalAddress(chat)
            ? chat.sessionId
            // A grantee's surface contributes no tabs at all (§5.1), so a
            // shared address can never be the host of one.
            : chat.sharedFrom === undefined
              ? chat.sessionId
              : undefined;
      const next: ChatAddress =
        sessionId === undefined ? { terminalId } : { sessionId, terminalId };
      go(workspaceChatTerminalPath(activeWorkspaceId, terminalId, sessionId), next);
    },
    [activeWorkspaceId, chat, go],
  );

  // The EXACT inverse of `openTerminal`, and the reason it is one function
  // rather than a branch at each call site: the terminal arm comes off the
  // address and the host page it named stays. A strip that has moved to a
  // conversation tab must leave the session it is drawn in — going to the
  // landing instead would take the member off the session they just clicked.
  const closeTerminal = useCallback(() => {
    if (!isChatTerminalAddress(chat)) return;
    const sessionId = chat.sessionId;
    if (sessionId === undefined) openLanding();
    else openSession(sessionId);
  }, [chat, openLanding, openSession]);

  const mirror = useCallback(
    (sessionId: string | null) => {
      // `chat === null` means the panes own the view; a background navigation
      // inside the hidden surface must not yank it back. Nor may a shared
      // session's address be overwritten by the OWN surface's router, which
      // keeps navigating in the background while it is hidden.
      if (!LODY_SESSIONS_ENABLED || chat === null) return;
      // A terminal selection is OURS, not the vendored router's: the router
      // does not know the tab exists, so its resolved address always names the
      // host page and never the tab. Following it here would drop the selection
      // on the first navigation. It is dropped only when the member moves the
      // surface to a DIFFERENT host page than the address names.
      if (isChatTerminalAddress(chat)) {
        if ((chat.sessionId ?? null) === sessionId) return;
      } else if (chatSharedFrom(chat) !== undefined) return;
      if (sessionId === null) {
        if (chat !== "landing") openLanding();
        return;
      }
      if (chat === "landing" || chat.sessionId !== sessionId) openSession(sessionId);
    },
    [chat, openLanding, openSession],
  );

  // THE SESSION THE STRIP WAS DRAWN IN DOES NOT EXIST.
  //
  // `SessionDetail` renders its not-found card and returns above the strip, so
  // every host tab goes with it — including the one the member is looking at.
  // The terminal is still open and its tmux session is still attached, so the
  // selection moves to the OTHER host: the landing's strip, which needs no
  // session to be rooted in. Replaces, because the address it leaves is one the
  // shell refused rather than one the member visited.
  const openTerminalOnLanding = useCallback(() => {
    if (!isChatTerminalAddress(chat) || chat.sessionId === undefined) return;
    const { terminalId } = chat;
    go(workspaceChatTerminalPath(activeWorkspaceId, terminalId), { terminalId }, { replace: true });
  }, [activeWorkspaceId, chat, go]);

  const closeChat = useCallback(
    (options?: { replace?: boolean }) => {
      if (chat === null) return;
      go(workspacePath(activeWorkspaceId), null, options);
    },
    [activeWorkspaceId, chat, go],
  );

  // THE WORKSPACE ROOT IS THE CHAT LANDING (§0.4, widened by the deletion).
  //
  // `/workspaces/:id` used to mean "the panes own the view", and the panes drew
  // their own tab strip. That strip is deleted (plans/LODY-TERMINAL-TABS.md
  // §4.6, "PR 2"), so on a layout where the SESSION strip draws the tabs the
  // root address now has no tab control at all — it is not a place a member can
  // be left. It is normalised into the chat plane instead.
  //
  // THIS IS THE OTHER HALF OF THE REFRESH RACE, and the half a boot skeleton
  // cannot fix. §0.4 ran this once per workspace and only for a document with
  // ZERO tabs, so a returning member with tabs stayed on the panes for good:
  // every bookmark, every workspace switch and every `closeChat()` landed on the
  // native strip and stayed there. The tab count is no longer consulted, and
  // neither is a once-per-workspace latch — an address that cannot draw tabs is
  // wrong every time it is reached, not only the first time.
  //
  // REPLACES, NEVER PUSHES. The member did not ask for this step, so the back
  // button must not have to walk through it.
  //
  // GATED ON `surfaceHostsTabs` AND NOT ON `available`. A box on a pre-Lody
  // image, a member with no machine here, and a mobile layout all keep the panes
  // — the strip they would be sent to does not exist for them, and the rail's
  // notice is the honest answer instead (`SessionRail`). `available` is true
  // throughout `probing`, so gating on it would send a cold load to a landing
  // that may turn out to be unreachable.
  useEffect(() => {
    if (!LODY_SESSIONS_ENABLED || !surfaceHostsTabs) return;
    if (route.page !== "webApp" || activeWorkspaceId === "" || !tabsLoaded) return;
    if (route.chat !== null) return;
    window.history.replaceState({}, "", workspaceChatPath(activeWorkspaceId));
    setRoute({ workspaceId: activeWorkspaceId, page: "webApp", chat: "landing" });
  }, [activeWorkspaceId, route, setRoute, surfaceHostsTabs, tabsLoaded]);

  return {
    available,
    visible: available && chat !== null,
    // A shared session is NOT this surface's address: it is mounted against
    // another box, by a second surface, so the own surface stays where it was.
    // A terminal address still names its HOST page, so the surface opens the
    // session whose strip the tab belongs to — or the landing, when it has none.
    sessionId:
      chat === null || chat === "landing"
        ? null
        : isChatTerminalAddress(chat)
          ? chat.sessionId ?? null
          : chat.sharedFrom !== undefined
            ? null
            : chat.sessionId,
    terminalId: isChatTerminalAddress(chat) ? chat.terminalId : null,
    chat,
    onVendorHost: available ? setRailHost : undefined,
    railHost,
    openLanding,
    openSession,
    openSharedSession,
    openTerminal,
    closeTerminal,
    openTerminalOnLanding,
    mirror,
    closeChat,
  };
}
