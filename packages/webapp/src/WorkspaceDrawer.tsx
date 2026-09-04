import type { CredentialRequestView } from '@blitzos/schema';
import {
  useRef,
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ControlPlaneClient } from './api';
import { maxDrawerWidth, type WorkspaceDrawerSegment } from './storage';
import {
  WorkspaceConnectionsPanel,
  type ConnectionsPanelFocus,
} from './WorkspaceConnectionsPanel';
import { GenericProviderIcon } from './WebAppIcons';

// The connections machinery lives in its own module; these re-exports keep
// the drawer the one import site its hosts and tests already use.
export {
  portAge,
  useWorkspaceCredentialEvents,
  WorkspaceConnectionsPanel,
  WorkspaceEventsPanel,
  WorkspaceRequestsPanel,
  type ConnectionsPanelFocus,
  type WorkspaceEventFeed,
} from './WorkspaceConnectionsPanel';

export type WorkspacePanelProps = {
  client: ControlPlaneClient;
  workspaceId: string;
  visible: boolean;
  pendingRequests: CredentialRequestView[];
  pendingRequestsError?: string | null;
  /** Provider names this workspace's allow-list holds. */
  workspaceConnections?: readonly string[];
  connectionsFocus?: ConnectionsPanelFocus | null;
  /** Workspace sharing, not an org role: a viewer sees the panel but cannot
   * connect or disconnect on this workspace's behalf. */
  readOnly?: boolean;
  onResolveRequest: (
    request: CredentialRequestView,
    action: 'approve' | 'deny',
  ) => Promise<void>;
};

/** One panel body, wherever it is hosted: a tab in a workspace pane on the
 * desktop, a segment of the off-canvas sheet below the mobile breakpoint.
 * Connections is the one panel left; `panel` stays in the signature so the
 * hosts keep naming what they draw. `visible` is read by the hosts' own gate
 * (`hidden`), not here: the connections panel draws the same either way. */
export function WorkspacePanelContent({
  client,
  workspaceId,
  pendingRequests,
  pendingRequestsError,
  workspaceConnections,
  connectionsFocus,
  readOnly,
  onResolveRequest,
}: WorkspacePanelProps & { panel: WorkspaceDrawerSegment }) {
  return (
    <WorkspaceConnectionsPanel
      client={client}
      workspaceId={workspaceId}
      readOnly={readOnly}
      pendingRequests={pendingRequests}
      pendingRequestsError={pendingRequestsError}
      workspaceConnections={workspaceConnections}
      connectionsFocus={connectionsFocus}
      onResolveRequest={onResolveRequest}
    />
  );
}

/** Below the mobile breakpoint the panels stay an off-canvas sheet with its
 * own segment strip — the panes never split there. */
export function WorkspaceDrawer({
  mobile,
  open,
  width,
  segment,
  onWidthChange,
  onSegmentChange,
  pendingRequests,
  ...panelProps
}: Omit<WorkspacePanelProps, 'visible'> & {
  mobile: boolean;
  open: boolean;
  width: number;
  segment: WorkspaceDrawerSegment;
  onWidthChange: (width: number) => void;
  onSegmentChange: (segment: WorkspaceDrawerSegment) => void;
}) {
  const resizeOrigin = useRef<{ x: number; width: number } | null>(null);
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (mobile || event.button !== 0) return;
    resizeOrigin.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = resizeOrigin.current;
    if (!origin) return;
    onWidthChange(Math.max(200, Math.min(maxDrawerWidth(window.innerWidth), origin.width + origin.x - event.clientX)));
  };

  const tabs: Array<{ id: WorkspaceDrawerSegment; label: string; icon: ReactNode }> = [
    {
      id: 'connections',
      label: 'Connections',
      icon: <GenericProviderIcon className="webapp-tab-icon" />,
    },
  ];
  const effectiveSegment = segment;

  return (
    <aside
      id="webapp-workspace-drawer"
      className={`workspace-drawer${open ? ' workspace-drawer--open' : ''}`}
      style={
        // SAFETY: React accepts CSS custom properties at runtime; CSSProperties omits arbitrary `--*` keys from its static surface.
        { '--files-sidebar-width': `${width}px` } as CSSProperties
      }
      aria-label="Workspace drawer"
      aria-hidden={mobile && !open ? true : undefined}
      inert={mobile && !open}
    >
      {!mobile && (
        <div
          className="files-sidebar-resizer"
          role="separator"
          aria-label="Resize workspace drawer"
          aria-orientation="vertical"
          onPointerDown={beginResize}
          onPointerMove={resize}
          onPointerUp={(event) => {
            resizeOrigin.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { resizeOrigin.current = null; }}
        />
      )}
      {/* One segment is no choice: the strip only draws when there is more
          than one section to switch between. */}
      {tabs.length > 1 && (
      <header className="workspace-drawer-segments" role="tablist" aria-label="Workspace drawer sections">
        {tabs.map((tab) => {
          const active = effectiveSegment === tab.id;
          return (
            <div
              className={`webapp-tab-cell${active ? ' webapp-tab-cell--active' : ''}`}
              key={tab.id}
            >
              <button
                className="webapp-tab-select"
                type="button"
                role="tab"
                aria-selected={active}
                title={tab.label}
                onClick={() => onSegmentChange(tab.id)}
              >
                {tab.icon}
                <span className="webapp-tab-label">{tab.label}</span>
                {tab.id === 'connections' && pendingRequests.length > 0 && (
                  <span className="workspace-pending-badge" aria-label={`${pendingRequests.length} pending`}>
                    {pendingRequests.length}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </header>
      )}
      <div className="workspace-drawer-body">
        {tabs.map((tab) => (
          <div role="tabpanel" hidden={effectiveSegment !== tab.id} key={tab.id}>
            <WorkspacePanelContent
              panel={tab.id}
              pendingRequests={pendingRequests}
              {...panelProps}
              visible={open && effectiveSegment === tab.id}
            />
          </div>
        ))}
      </div>
    </aside>
  );
}
