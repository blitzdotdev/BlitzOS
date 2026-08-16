type LoadingPaneProps = {
  ariaLabel: string;
  stage?: string;
};

export function WebAppLoadingPane({ ariaLabel, stage }: LoadingPaneProps) {
  return (
    <div className="webapp-loading-pane" role="status" aria-label={ariaLabel} aria-live="polite">
      {stage && <div className="webapp-loading-stage">{stage}</div>}
      <div className="webapp-loading-pane__outline webapp-loading-shape" aria-hidden="true">
        <span className="webapp-loading-line webapp-loading-line--short" />
        <span className="webapp-loading-line" />
        <span className="webapp-loading-line webapp-loading-line--tiny" />
        <span className="webapp-loading-line webapp-loading-line--short" />
      </div>
    </div>
  );
}

export function OutlinedLoadingRows({ ariaLabel, count = 3 }: { ariaLabel: string; count?: number }) {
  return (
    <div className="webapp-loading-rows" role="status" aria-label={ariaLabel} aria-live="polite">
      {Array.from({ length: count }, (_, index) => (
        <span
          className={`webapp-loading-rows__row webapp-loading-shape${index === 0 ? ' webapp-loading-rows__row--short' : ''}`}
          key={index}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

export function WebAppLoadingShell({
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
        className={`webapp-loading-rail${drawerOpen ? ' webapp-loading-rail--drawer-open' : ''}`}
        aria-label="Loading workspace navigation"
        aria-hidden={mobile && !drawerOpen ? true : undefined}
        inert={mobile && !drawerOpen}
      >
        <div className="webapp-loading-rail__head">
          <button type="button" aria-label="Close workspace navigation" onClick={onCloseDrawer}>×</button>
        </div>
        <div className="webapp-loading-rail__row webapp-loading-shape" />
        <div className="webapp-loading-rail__row webapp-loading-shape" />
        <div className="webapp-loading-rail__row webapp-loading-shape" />
      </aside>
      <header className="webapp-loading-header">
        {mobile && (
          <button
            className="webapp-loading-drawer-open"
            type="button"
            aria-label="Open workspace navigation"
            onClick={onOpenDrawer}
          ><span aria-hidden="true">☰</span></button>
        )}
        <div className="webapp-loading-tabstrip" aria-hidden="true">
          <span className="webapp-loading-tab webapp-loading-shape" />
          <span className="webapp-loading-tab webapp-loading-shape" />
        </div>
      </header>
      <section className="webapp-workspace-view">
        <WebAppLoadingPane ariaLabel="Loading webApp" stage={stage} />
      </section>
      <footer className="webapp-loading-status webapp-loading-shape" aria-hidden="true" />
      <button
        className={`webapp-drawer-scrim${drawerOpen ? ' webapp-drawer-scrim--open' : ''}`}
        type="button"
        aria-label="Close workspace navigation"
        tabIndex={-1}
        onClick={onCloseDrawer}
      />
    </>
  );
}
