import {
  CONNECTIONS_SIDE_PANEL_ID,
  SIDE_PANEL_QUICK_ACTIONS,
  SIDE_PANEL_QUICK_ACTION_LABELS,
  sidePanelQuickActionIcon,
  type SessionSidePanelHostState,
  type SidePanelQuickAction,
} from './lody/side-panel';

/**
 * The right icon strip: a quick-action bar over Lody's side panel.
 *
 * ONE ICON PER PANEL, THE SAME ICON THE PANEL'S TAB WEARS. Five buttons in the
 * side panel's own order — Side Chat, Files, All Changes, Browser, and our
 * Connections — each opening that panel in the session on screen, and closing
 * it again when it is the one in front. The glyphs are the lucide icons Lody's
 * tab bar draws for the same kinds (`side-panel.tsx`), so the bar a member
 * learns here is the bar they read on the panel.
 *
 * TWO HOSTS FOR CONNECTIONS. While a session detail is on screen the
 * Connections button opens our host tab inside Lody's side panel (seam patch
 * 10). With no session on screen — the chat landing, the flag off, a box that
 * serves no daemon — there is no side panel to open it in, so the button falls
 * back to the native panel tab it always had. `sidePanel === null` is that
 * second case.
 *
 * THE OTHER FOUR STILL WORK THERE, and that is what `landingSessionId` is for.
 * A panel of a session needs a session, and on the landing there is none on
 * screen — but the member usually HAS one, and pressing Files to be told to go
 * find it first is a button that knows the answer and refuses to act on it. So
 * the shell hands the strip the session it would open (the most recent one),
 * the press opens it, and the request is replayed into it. Only a member with
 * no session at all meets a disabled button, and then it says what to do.
 */
export function WorkspaceRailStrip({
  sidePanel,
  connectionsOpen,
  landingSessionId,
  pendingRequestCount,
  onQuickAction,
}: {
  /** Lody's side panel state, or `null` while no session detail is mounted. */
  sidePanel: SessionSidePanelHostState | null;
  /** Whether the NATIVE connections panel tab is the one in front; read only
   * while `sidePanel` is null. */
  connectionsOpen: boolean;
  /** The session a press would open while `sidePanel` is null, or `null` when
   * the member has none. Read only for whether it exists and what to say — the
   * shell is what opens it. */
  landingSessionId: string | null;
  pendingRequestCount: number;
  onQuickAction: (action: SidePanelQuickAction) => void;
}) {
  const available = new Set(
    (sidePanel?.availableOptions ?? [])
      .filter((option) => !option.disabled)
      .map((option) => option.id),
  );
  const opened = new Set(sidePanel?.openedTabIds ?? []);
  return (
    <nav className="webapp-rail-strip" aria-label="Workspace panels">
      {SIDE_PANEL_QUICK_ACTIONS.map((action) => {
        const isConnections = action === CONNECTIONS_SIDE_PANEL_ID;
        const isLauncher = action === 'side-session';
        const label = SIDE_PANEL_QUICK_ACTION_LABELS[action];
        // A panel is offered while its option is offered OR its tab is already
        // open: Browser leaves the `+` menu once opened but stays a tab.
        const offered = sidePanel === null
          ? isConnections || landingSessionId !== null
          : available.has(action) || opened.has(action);
        const pressed = isLauncher
          ? false
          : sidePanel === null
            ? isConnections && connectionsOpen
            : sidePanel.open && sidePanel.activeTabId === action;
        const title = offered
          ? sidePanel === null && !isConnections
            // The press does two things there, and the tooltip says the one
            // the member has not asked for.
            ? `${label} — in your most recent session`
            : label
          : sidePanel === null
            ? `${label} — start a session first`
            // A SIDE CHAT IS A FORK OF AN ANSWER, so before the agent has given
            // one there is nothing to fork and upstream's own launcher refuses
            // (`sessions.forkNoAssistant`). Naming that is the difference
            // between "wait" and "this session cannot do it".
            //
            // It is the reason a member meets in practice, not the only one:
            // an offline machine disables the same launcher. That case takes
            // the whole surface with it and the footer's status line is what
            // says so, so the tooltip names the one a running session has.
            : isLauncher
              ? `${label} — after the agent's first reply`
              : `${label} — not available in this session`;
        return (
          <div className="webapp-rail-strip__slot" key={action}>
            {isConnections && <span className="webapp-rail-strip__rule" aria-hidden="true" />}
            <button
              className={`webapp-rail-strip__button${pressed ? ' webapp-rail-strip__button--open' : ''}`}
              type="button"
              title={title}
              aria-label={label}
              aria-pressed={isLauncher ? undefined : pressed}
              disabled={!offered}
              onClick={() => onQuickAction(action)}
            >
              {sidePanelQuickActionIcon(action, 'webapp-rail-strip__icon')}
              {isConnections && pendingRequestCount > 0 && (
                <span
                  className="workspace-pending-badge"
                  aria-label={`${pendingRequestCount} pending`}
                >{pendingRequestCount}</span>
              )}
            </button>
          </div>
        );
      })}
    </nav>
  );
}
