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
 * second case; the four Lody buttons stay drawn and disabled there, so the bar
 * keeps its shape and its vocabulary.
 */
export function WorkspaceRailStrip({
  sidePanel,
  connectionsOpen,
  pendingRequestCount,
  onQuickAction,
}: {
  /** Lody's side panel state, or `null` while no session detail is mounted. */
  sidePanel: SessionSidePanelHostState | null;
  /** Whether the NATIVE connections panel tab is the one in front; read only
   * while `sidePanel` is null. */
  connectionsOpen: boolean;
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
          ? isConnections
          : available.has(action) || opened.has(action);
        const pressed = isLauncher
          ? false
          : sidePanel === null
            ? isConnections && connectionsOpen
            : sidePanel.open && sidePanel.activeTabId === action;
        const title = offered
          ? label
          : sidePanel === null
            ? `${label} — open a session first`
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
