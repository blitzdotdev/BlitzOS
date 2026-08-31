/**
 * One workspace tab's BODY, lifted out of `shell/WorkPanes.tsx`
 * (plans/LODY-TERMINAL-TABS.md §3.5, §8).
 *
 * The switch below was `WorkPanes`'s `renderedSessions.map` — panel, preview,
 * file, terminal. It moved here because two hosts now draw it: the pane grid,
 * exactly as before, and a tab of Lody's session strip. Splitting it is what
 * keeps the flag-off column of §6 byte-identical while the flag-on column
 * renders the same bodies somewhere else.
 *
 * WHAT STAYED IN `WorkPanes`: the wrapper `div`, its `data-region` placement,
 * its `hidden` rule and the grid it sits in. Those are pane layout, and the
 * strip host has its own (`absolute inset-0` + `hidden`, seam patch 5 hunk 8).
 * This component renders a body and nothing around it.
 */
import type { CredentialRequestView } from '@blitzos/schema';
import type { WebDAVClient } from 'webdav';
import type { ControlPlaneClient } from '../api';
import { FileEditor } from '../FileEditor';
import { PreviewPanel } from '../PreviewPanel';
import { TtydTerminal } from '../TtydTerminal';
import type { LivePort, PreviewLink } from '../preview';
import type { WorkspaceTab } from '../storage';
import type { CloudWorkspaceModel } from '../workspace-store';
import {
  WorkspacePanelContent,
  type ConnectionsPanelFocus,
} from '../WorkspaceDrawer';
import type { ReactNode } from 'react';

export type SurfaceTabContentProps = {
  session: WorkspaceTab;
  /** Drives the terminal's fit/focus and the panel's own visibility gate. */
  active: boolean;
  client: ControlPlaneClient;
  activeWorkspace: CloudWorkspaceModel | undefined;
  activeWorkspaceId: string;
  activeWorkspaceRunning: boolean;
  activeSessionUrl: string | null;
  activeFilesBase: string | null;
  filesClient: WebDAVClient | null;
  filesSidebar: ReactNode;
  orgName: string;
  workspaceWakingStage: string | undefined;
  livePorts: LivePort[];
  previewLinks: PreviewLink[];
  pendingRequests: CredentialRequestView[];
  pendingRequestsError: string | null;
  connectionsFocus: ConnectionsPanelFocus | null;
  onResolveRequest: (
    request: CredentialRequestView,
    action: 'approve' | 'deny',
  ) => Promise<void>;
  onFileDirtyChange: (sessionId: string, dirty: boolean) => void;
  onFilesRefresh: () => void;
  onUnauthorized: () => void;
  onSignInUrl: (url: string | null) => void;
  onOpenPreview: (port: number, path?: string) => boolean;
  onOpenPreviewLink: (url: string, title: string) => boolean;
};

/** The pane class one tab's wrapper carries. Stated here beside the switch it
 * belongs to, so a new tab kind cannot get a body and lose its placement. */
export function surfaceTabPaneClassName(session: WorkspaceTab): string {
  if (session.type === 'panel') return 'webapp-workspace-session webapp-pane-panel';
  if (session.type === 'preview') return 'webapp-workspace-session webapp-pane-preview';
  return 'webapp-workspace-session';
}

export function SurfaceTabContent({
  session,
  active,
  client,
  activeWorkspace,
  activeWorkspaceId,
  activeWorkspaceRunning,
  activeSessionUrl,
  activeFilesBase,
  filesClient,
  filesSidebar,
  orgName,
  workspaceWakingStage,
  livePorts,
  previewLinks,
  pendingRequests,
  pendingRequestsError,
  connectionsFocus,
  onResolveRequest,
  onFileDirtyChange,
  onFilesRefresh,
  onUnauthorized,
  onSignInUrl,
  onOpenPreview,
  onOpenPreviewLink,
}: SurfaceTabContentProps) {
  const sessionId = String(session.id);
  if (session.type === 'panel') {
    return (
      <WorkspacePanelContent
        panel={session.panel}
        client={client}
        workspaceId={activeWorkspaceId}
        orgName={orgName}
        visible={active}
        files={filesSidebar}
        pendingRequests={pendingRequests}
        pendingRequestsError={pendingRequestsError}
        workspaceConnections={activeWorkspace?.connections ?? []}
        connectionsFocus={connectionsFocus}
        readOnly={activeWorkspace?.accessRole === 'viewer'}
        onResolveRequest={onResolveRequest}
        livePorts={livePorts}
        previewLinks={previewLinks}
        filesBase={activeFilesBase}
        previewReady={activeWorkspaceRunning}
        onOpenPreview={(port) => { onOpenPreview(port); }}
        onOpenPreviewLink={(url, title) => { onOpenPreviewLink(url, title); }}
      />
    );
  }
  if (session.type === 'preview') {
    return (
      <PreviewPanel
        target={'port' in session
          ? session.port
          : { url: session.url, title: session.title }}
        path={'port' in session ? session.path : undefined}
        filesBase={activeFilesBase}
        running={activeWorkspaceRunning}
      />
    );
  }
  if (session.type === 'file') {
    return (
      <FileEditor
        active={active}
        client={filesClient}
        filePath={session.filePath}
        unavailableStage={workspaceWakingStage}
        onDirtyChange={(dirty) => onFileDirtyChange(sessionId, dirty)}
        onSaved={onFilesRefresh}
        onTreeRefresh={onFilesRefresh}
        onUnauthorized={onUnauthorized}
      />
    );
  }
  return (
    <TtydTerminal
      url={activeSessionUrl ?? ''}
      sessionType={session.type}
      sessionKey={sessionId}
      active={active}
      readOnly={activeWorkspace?.accessRole === 'viewer'}
      onSignInUrl={onSignInUrl}
      onOpenPreview={onOpenPreview}
    />
  );
}
