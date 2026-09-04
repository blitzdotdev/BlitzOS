/**
 * The strip's SECOND host: the chat landing
 * (plans/LODY-TERMINAL-TABS.md §3.4).
 *
 * `SessionDetail` is the strip's only vendored host and it needs a session. A
 * flag-on workspace opens the chat landing with zero tabs, so "open a terminal
 * before you open a chat" has to work or the feature is unusable on a fresh
 * workspace. The answer is OUR composition rather than a second vendor patch:
 * the SAME vendored `SessionTabBar`, in the `variant="viewer"` upstream already
 * declares, with no session tabs because there are no sessions to draw.
 *
 * Two mount points, one component, one tab array, one selection, one address.
 *
 * `parentSession` is deliberately not passed. Upstream declared
 * `variant="viewer"` and then required the prop that variant tells the strip not
 * to draw; seam patch 5's hunks 2-4 make it optional, and this is the call site
 * that would stop compiling if a merge lost them.
 */
import type { ReactNode } from "react";
import { SessionTabBar } from "@lody/components/components/sessions/session-tab-bar";
import type { SurfaceTabsBinding } from "./surface-tabs.js";

/** Upstream's own empty-list defaults, hoisted to module scope so the memoized
 * `SessionTabBar` is not handed three fresh arrays per render. */
const NO_SESSIONS: never[] = [];

export interface TerminalTabsStripProps {
  surfaceTabs: SurfaceTabsBinding;
}

export function TerminalTabsStrip({ surfaceTabs }: TerminalTabsStripProps) {
  if (surfaceTabs.tabs.length === 0) return null;
  return (
    <div className="lody-terminal-tabs-strip shrink-0">
      <SessionTabBar
        variant="viewer"
        childSessions={NO_SESSIONS}
        draftTabs={NO_SESSIONS}
        archivedChildSessions={NO_SESSIONS}
        activeTabSessionId=""
        // `variant="viewer"` draws no session tabs and no `+`, so neither of
        // these can fire. They are required props, and a strip that cannot
        // reach them is the reason the variant exists.
        onTabSelect={() => {}}
        onNewTab={() => {}}
        viewerTabs={surfaceTabs.tabs.map((tab) => ({
          id: tab.id,
          type: "custom" as const,
          label: tab.label,
          icon: tab.icon,
        }))}
        activeViewerTabId={surfaceTabs.activeTabId}
        onViewerTabSelect={surfaceTabs.onSelect}
        onViewerTabClose={surfaceTabs.onClose}
        className="mt-0.5 h-11"
      />
    </div>
  );
}

/**
 * The landing host: the strip, then either the landing or the selected tab.
 *
 * The host tabs are mounted and merely hidden, exactly as seam patch 5's hunk
 * 15 mounts them inside `SessionDetail` — a terminal must survive a tab switch
 * without a reconnect. The landing is hidden rather than unmounted for the same
 * reason: it holds the member's unsent draft.
 */
export function TerminalTabsHost(props: {
  surfaceTabs: SurfaceTabsBinding;
  landing: ReactNode;
  /**
   * Draw the strip above the landing. TRUE on desktop, FALSE on a phone.
   *
   * The strip is the DESKTOP tab affordance. Lody's phone layout carries its
   * own — a bottom tab bar on the landing, a tab sheet inside a session — and a
   * strip above them would be a second tab system on one screen, which is the
   * thing `plans/LODY-TERMINAL-TABS.md` exists to prevent. A phone reaches a
   * terminal from the BlitzOS drawer rail and from the mobile tab sheet
   * (seam patch 16), so nothing is lost with the strip off.
   *
   * The CONTENT half is unchanged either way: a selected host tab still covers
   * the landing, and every tab stays mounted.
   */
  showStrip?: boolean;
}) {
  const { surfaceTabs, landing, showStrip = true } = props;
  const activeTabId =
    surfaceTabs.activeTabId !== null
    && surfaceTabs.tabs.some((tab) => tab.id === surfaceTabs.activeTabId)
      ? surfaceTabs.activeTabId
      : null;
  return (
    <div className="lody-terminal-tabs-host flex h-full min-h-0 flex-col">
      {showStrip ? <TerminalTabsStrip surfaceTabs={surfaceTabs} /> : null}
      <div className="relative min-h-0 flex-1">
        <div
          className={activeTabId === null ? "absolute inset-0" : "absolute inset-0 hidden"}
          aria-hidden={activeTabId !== null}
          data-surface-tab-id="landing"
        >
          {landing}
        </div>
        {surfaceTabs.tabs.map((tab) => (
          <div
            key={tab.id}
            className={tab.id === activeTabId ? "absolute inset-0" : "absolute inset-0 hidden"}
            aria-hidden={tab.id !== activeTabId}
            data-surface-tab-id={tab.id}
          >
            {tab.content}
          </div>
        ))}
      </div>
    </div>
  );
}
