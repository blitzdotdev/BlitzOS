type LoadingPaneProps = {
  ariaLabel: string;
  stage?: string;
};

export function CockpitLoadingPane({ ariaLabel, stage }: LoadingPaneProps) {
  return (
    <div className="cockpit-loading-pane" role="status" aria-label={ariaLabel} aria-live="polite">
      {stage && <div className="cockpit-loading-stage">{stage}</div>}
      <div className="cockpit-loading-pane__outline cockpit-loading-shape" aria-hidden="true">
        <span className="cockpit-loading-line cockpit-loading-line--short" />
        <span className="cockpit-loading-line" />
        <span className="cockpit-loading-line cockpit-loading-line--tiny" />
        <span className="cockpit-loading-line cockpit-loading-line--short" />
      </div>
    </div>
  );
}

export function OutlinedLoadingRows({ ariaLabel, count = 3 }: { ariaLabel: string; count?: number }) {
  return (
    <div className="cockpit-loading-rows" role="status" aria-label={ariaLabel} aria-live="polite">
      {Array.from({ length: count }, (_, index) => (
        <span
          className={`cockpit-loading-rows__row cockpit-loading-shape${index === 0 ? ' cockpit-loading-rows__row--short' : ''}`}
          key={index}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

export function CockpitLoadingShell({
  stage,
  mobile = false,
  drawerOpen = false,
  onOpenDrawer = () => undefined,
  onCloseDrawer = () => undefined,
}: {
  stage: string;
  mobile?: boolean;
  drawerOpen?: boolean;
  onOpenDrawer?: () => void;
  onCloseDrawer?: () => void;
}) {
  return (
    <>
      <aside
        className={`cockpit-loading-rail${drawerOpen ? ' cockpit-loading-rail--drawer-open' : ''}`}
        aria-label="Loading workspace navigation"
        aria-hidden={mobile && !drawerOpen ? true : undefined}
        inert={mobile && !drawerOpen}
      >
        <div className="cockpit-loading-rail__head">
          <button type="button" aria-label="Close workspace navigation" onClick={onCloseDrawer}>×</button>
        </div>
        <div className="cockpit-loading-rail__row cockpit-loading-shape" />
        <div className="cockpit-loading-rail__row cockpit-loading-shape" />
        <div className="cockpit-loading-rail__row cockpit-loading-shape" />
      </aside>
      <header className="cockpit-loading-header">
        {mobile && (
          <button
            className="cockpit-loading-drawer-open"
            type="button"
            aria-label="Open workspace navigation"
            onClick={onOpenDrawer}
          ><span aria-hidden="true">☰</span></button>
        )}
        <div className="cockpit-loading-tabstrip" aria-hidden="true">
          <span className="cockpit-loading-tab cockpit-loading-shape" />
          <span className="cockpit-loading-tab cockpit-loading-shape" />
        </div>
      </header>
      <section className="cockpit-workspace-view">
        <CockpitLoadingPane ariaLabel="Loading cockpit" stage={stage} />
      </section>
      <footer className="cockpit-loading-status cockpit-loading-shape" aria-hidden="true" />
      <button
        className={`cockpit-drawer-scrim${drawerOpen ? ' cockpit-drawer-scrim--open' : ''}`}
        type="button"
        aria-label="Close workspace navigation"
        tabIndex={-1}
        onClick={onCloseDrawer}
      />
    </>
  );
}
