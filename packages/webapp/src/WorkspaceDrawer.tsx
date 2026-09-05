import type { CredentialRequestView } from '@blitzos/schema';
import type { ControlPlaneClient } from './api';
import type { WorkspaceDrawerSegment } from './storage';
import {
  WorkspaceConnectionsPanel,
  type ConnectionsPanelFocus,
} from './WorkspaceConnectionsPanel';

/* THE OFF-CANVAS SHEET IS GONE. `WorkspaceDrawer` hosted one segment,
 * Connections, below the mobile breakpoint; connections are a tab of the
 * workspace-details dialog now, on every width, so the sheet had nothing left
 * to show and the shell mounts none.
 *
 * WHAT IS LEFT IS THE PANEL BODY. A layout persisted before this change can
 * still hold a `panel` tab, and `lody/SurfaceTabContent.tsx` draws its body
 * through `WorkspacePanelContent` — so this module stays the one import site
 * its hosts and tests already use, and nothing creates a new such tab. */
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

/** One panel body, in the one host left: a `panel` tab of a workspace pane
 * that a persisted layout still holds. `panel` stays in the signature so the
 * host keeps naming what it draws. `visible` is read by the host's own gate
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
