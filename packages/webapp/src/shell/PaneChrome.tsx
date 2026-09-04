/**
 * The one row above the panes, and the whole of what is left of it.
 *
 * The native tab strip used to live here — one `WebAppHeader` per visible
 * region, drawn by `WorkPanes` (plans/LODY-TERMINAL-TABS.md §4.6). It is
 * deleted: a terminal is a tab of Lody's session strip and there is no second
 * strip anywhere. Two things it carried are not about tabs at all, so they stay:
 *
 * 1. **The mobile drawer button.** Below the mobile breakpoint the workspace
 *    rail, the workspace switcher and every dialog they open live in an
 *    off-canvas drawer, and on a loaded workspace page this button is the only
 *    thing that opens it. The edge-swipe gesture is a shortcut, not an
 *    affordance.
 * 2. **The boot placeholder.** The session plane answers one probe before the
 *    strip can exist (`lody/box-capability.ts`). That window used to draw the
 *    native strip and then swap it for the vendored one, which is the flicker
 *    a member reads as "the old tabs came back on refresh". It now draws a
 *    skeleton in the strip's place — the same shape `WebAppLoadingShell`
 *    already uses, so a cold load looks like one surface settling rather than
 *    two surfaces arguing.
 *
 * It renders nothing at all once the probe has settled on a desktop layout,
 * which is the ordinary case: the strip is the surface's.
 */
export type PaneChromeProps = {
  mobile: boolean;
  drawerOpen: boolean;
  /**
   * The session plane has not answered yet, so nothing can draw the strip.
   * `CloudApp`'s `sessionPlanePending`.
   */
  pending: boolean;
  onOpenDrawer: () => void;
};

export function PaneChrome({ mobile, drawerOpen, pending, onOpenDrawer }: PaneChromeProps) {
  if (!mobile && !pending) return null;
  return (
    <div className="webapp-pane-chrome">
      {mobile && (
        <button
          className="webapp-drawer-open"
          type="button"
          aria-label="Open workspace navigation"
          aria-expanded={drawerOpen}
          onClick={onOpenDrawer}
        ><span aria-hidden="true">☰</span></button>
      )}
      {pending && (
        <div
          className="webapp-loading-tabstrip"
          role="status"
          aria-label="Loading sessions"
          aria-live="polite"
        >
          <span className="webapp-loading-tab webapp-loading-shape" aria-hidden="true" />
          <span className="webapp-loading-tab webapp-loading-shape" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
