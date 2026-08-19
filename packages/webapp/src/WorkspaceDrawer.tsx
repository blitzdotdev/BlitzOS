import type { CredentialEventView, CredentialLeaseView, CredentialRequestView } from '@blitzos/schema';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ControlPlaneClient } from './api';
import { ConfirmationDialog } from './ConfirmationDialog';
import { caughtErrorMessage } from './error-message';
import type { LivePort, PreviewLink } from './preview';
import { maxDrawerWidth, type WorkspaceDrawerSegment } from './storage';
import { TeenyappsPanel } from './TeenyappsPanel';
import { asJsonObject, isString } from './type-guards';
import { FolderIcon, GenericProviderIcon } from './WebAppIcons';

export const CREDENTIAL_POLL_INTERVAL_MS = 5_000;

export function portAge(firstSeenAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - firstSeenAt) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

export function expiryCountdown(expiresAt: number, now = Date.now()): string {
  const seconds = Math.ceil((expiresAt - now) / 1_000);
  if (seconds <= 0) return 'expired';
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours}h left`;
  return `${Math.ceil(hours / 24)}d left`;
}

export function WorkspaceLeasesPanel({
  client,
  workspaceId,
  visible,
}: {
  client: ControlPlaneClient;
  workspaceId: string;
  visible: boolean;
}) {
  const [leases, setLeases] = useState<CredentialLeaseView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<CredentialLeaseView | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!visible) return;
    let active = true;
    let request: AbortController | null = null;
    const poll = async () => {
      request?.abort();
      const current = new AbortController();
      request = current;
      try {
        const response = await client.listLeases(workspaceId, current.signal);
        if (!active || request !== current || current.signal.aborted) return;
        setLeases(response.leases);
        setLoading(false);
        setError(null);
      } catch (caught) {
        if (!active || request !== current || current.signal.aborted) return;
        setLoading(false);
        setError(caughtErrorMessage(caught, 'Credential leases failed to load.'));
      } finally {
        if (request === current) request = null;
      }
    };
    void poll();
    const pollTimer = window.setInterval(() => { void poll(); }, CREDENTIAL_POLL_INTERVAL_MS);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      active = false;
      request?.abort();
      window.clearInterval(pollTimer);
      window.clearInterval(clockTimer);
    };
  }, [client, visible, workspaceId]);

  const revoke = async (lease: CredentialLeaseView) => {
    if (revoking !== null) return;
    setConfirmation(null);
    setRevoking(lease.id);
    setError(null);
    try {
      await client.revokeLease(lease.id);
      setLeases((current) => current.map((entry) => (
        entry.id === lease.id ? { ...entry, state: 'revoked' } : entry
      )));
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Credential lease revoke failed.'));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section className="workspace-drawer-panel workspace-leases" aria-label="Workspace credential leases">
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      {loading ? (
        <p className="workspace-drawer-state">Loading leases…</p>
      ) : leases.length === 0 ? (
        <p className="workspace-drawer-state">No credential leases for this workspace.</p>
      ) : (
        <div className="workspace-credential-rows">
          {leases.map((lease) => {
            const state = lease.state === 'active' && lease.expiresAt <= now
              ? 'expired'
              : lease.state;
            return (
            <article className="workspace-credential-row" key={lease.id}>
              <div className="workspace-credential-row__title">
                <strong>{lease.integration}</strong>
                <span className={`workspace-state-badge workspace-state-badge--${state}`}>
                  {state}
                </span>
              </div>
              <p>{lease.scopes.length === 0 ? 'No named scopes' : lease.scopes.join(', ')}</p>
              <div className="workspace-credential-row__meta">
                <span>{lease.mode}</span>
                <time dateTime={new Date(lease.expiresAt).toISOString()}>
                  {state === 'active' ? expiryCountdown(lease.expiresAt, now) : state}
                </time>
              </div>
              <button
                className="webapp-action workspace-credential-row__action"
                type="button"
                disabled={state !== 'active' || revoking !== null}
                onClick={() => setConfirmation(lease)}
              >{revoking === lease.id ? 'Revoking…' : 'Revoke'}</button>
            </article>
            );
          })}
        </div>
      )}
      {confirmation && (
        <ConfirmationDialog
          title="Revoke credential lease?"
          description={`Revoke ${confirmation.integration} access for this workspace immediately?`}
          confirmLabel="Revoke lease"
          onCancel={() => setConfirmation(null)}
          onConfirm={() => { void revoke(confirmation); }}
        />
      )}
    </section>
  );
}

export function WorkspaceRequestsPanel({
  requests,
  loadError,
  onResolve,
}: {
  requests: CredentialRequestView[];
  loadError?: string | null;
  onResolve: (request: CredentialRequestView, action: 'approve' | 'deny') => Promise<void>;
}) {
  const [resolving, setResolving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (request: CredentialRequestView, action: 'approve' | 'deny') => {
    if (resolving !== null) return;
    setResolving(request.id);
    setError(null);
    try {
      await onResolve(request, action);
    } catch (caught) {
      setError(caughtErrorMessage(caught, `Request ${action} failed.`));
    } finally {
      setResolving(null);
    }
  };

  return (
    <section className="workspace-drawer-panel workspace-requests" aria-label="Workspace pending credential requests">
      {(error ?? loadError) && <p className="webapp-form-message" role="alert">{error ?? loadError}</p>}
      {requests.length === 0 ? (
        <p className="workspace-drawer-state">No pending requests for this workspace.</p>
      ) : (
        <div className="workspace-credential-rows">
          {requests.map((request) => (
            <article className="workspace-credential-row" key={request.id}>
              <div className="workspace-credential-row__title">
                <strong>{request.integration_name}</strong>
                <span className="workspace-state-badge workspace-state-badge--active">pending</span>
              </div>
              <p>{request.requested_scopes.length === 0
                ? 'Integration access · no named scopes'
                : request.requested_scopes.join(', ')}</p>
              <div className="workspace-credential-row__meta">
                <time dateTime={new Date(request.created_at).toISOString()}>
                  {new Date(request.created_at).toLocaleString()}
                </time>
              </div>
              <div className="workspace-credential-row__actions">
                <button
                  className="webapp-action"
                  type="button"
                  disabled={resolving !== null}
                  onClick={() => { void resolve(request, 'deny'); }}
                >Deny</button>
                <button
                  className="webapp-action webapp-action--primary"
                  type="button"
                  disabled={resolving !== null}
                  onClick={() => { void resolve(request, 'approve'); }}
                >{resolving === request.id ? 'Working…' : 'Approve'}</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function eventActor(event: CredentialEventView): string | null {
  const detail = asJsonObject(event.detail);
  const acting = detail === null ? null : asJsonObject(detail.acting_principal);
  return acting !== null && isString(acting.userId) ? acting.userId : null;
}

export function WorkspaceEventsPanel({
  client,
  workspaceId,
  visible,
}: {
  client: ControlPlaneClient;
  workspaceId: string;
  visible: boolean;
}) {
  const [events, setEvents] = useState<CredentialEventView[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    const request = new AbortController();
    void client.listCredentialEvents(workspaceId, request.signal).then(
      (response) => setEvents(response.events),
      (caught) => {
        if (!request.signal.aborted) setError(caughtErrorMessage(caught, 'Credential events failed to load.'));
      },
    );
    return () => request.abort();
  }, [client, visible, workspaceId]);
  return (
    <section className="workspace-drawer-panel" aria-label="Workspace credential events">
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      {events.length === 0 ? <p className="workspace-drawer-state">No credential events for this workspace.</p> : (
        <div className="workspace-credential-rows">
          {events.map((event) => (
            <article className="workspace-credential-row" key={event.id}>
              <div className="workspace-credential-row__title"><strong>{event.event}</strong></div>
              <div className="workspace-credential-row__meta">
                <span>{eventActor(event) ?? 'system'}</span>
                <time dateTime={new Date(event.createdAt).toISOString()}>{new Date(event.createdAt).toLocaleString()}</time>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function WorkspaceIntegrationsPanel({
  client,
  workspaceId,
  visible,
  pendingRequests,
  pendingRequestsError,
  onResolveRequest,
}: {
  client: ControlPlaneClient;
  workspaceId: string;
  visible: boolean;
  pendingRequests: CredentialRequestView[];
  pendingRequestsError?: string | null;
  onResolveRequest: (
    request: CredentialRequestView,
    action: 'approve' | 'deny',
  ) => Promise<void>;
}) {
  return (
    <div className="workspace-integrations">
      <h3 className="workspace-sect workspace-sect--pending">Pending requests</h3>
      <WorkspaceRequestsPanel
        requests={pendingRequests}
        loadError={pendingRequestsError}
        onResolve={onResolveRequest}
      />
      <h3 className="workspace-sect">Active leases</h3>
      <WorkspaceLeasesPanel client={client} workspaceId={workspaceId} visible={visible} />
      <h3 className="workspace-sect">Recent activity</h3>
      <WorkspaceEventsPanel client={client} workspaceId={workspaceId} visible={visible} />
    </div>
  );
}

export type WorkspacePanelProps = {
  client: ControlPlaneClient;
  workspaceId: string;
  orgName: string;
  visible: boolean;
  files: ReactNode;
  pendingRequests: CredentialRequestView[];
  pendingRequestsError?: string | null;
  canManageCredentials: boolean;
  onResolveRequest: (
    request: CredentialRequestView,
    action: 'approve' | 'deny',
  ) => Promise<void>;
  livePorts: LivePort[];
  previewLinks: PreviewLink[];
  filesBase: string | null;
  previewReady: boolean;
  onOpenPreview: (port: number) => void;
  onOpenPreviewLink: (url: string, title: string) => void;
};

/** One panel body, wherever it is hosted: a tab in a workspace pane on the
 * desktop, a segment of the off-canvas sheet below the mobile breakpoint. */
export function WorkspacePanelContent({
  panel,
  client,
  workspaceId,
  orgName,
  visible,
  files,
  pendingRequests,
  pendingRequestsError,
  canManageCredentials,
  onResolveRequest,
  livePorts,
  previewLinks,
  filesBase,
  previewReady,
  onOpenPreview,
  onOpenPreviewLink,
}: WorkspacePanelProps & { panel: WorkspaceDrawerSegment }) {
  if (panel === 'files') return <>{files}</>;
  if (panel === 'previews') {
    return (
      <TeenyappsPanel
        orgName={orgName}
        workspaceId={workspaceId}
        livePorts={livePorts}
        previewLinks={previewLinks}
        filesBase={filesBase}
        previewReady={previewReady}
        onOpenPreview={onOpenPreview}
        onOpenPreviewLink={onOpenPreviewLink}
      />
    );
  }
  return canManageCredentials ? (
    <WorkspaceIntegrationsPanel
      client={client}
      workspaceId={workspaceId}
      visible={visible}
      pendingRequests={pendingRequests}
      pendingRequestsError={pendingRequestsError}
      onResolveRequest={onResolveRequest}
    />
  ) : null;
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
  canManageCredentials,
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
    { id: 'files', label: 'Files', icon: <FolderIcon className="webapp-tab-icon" /> },
    {
      id: 'previews',
      label: 'teenyapps',
      icon: <span className="webapp-tab-icon mi-preview" aria-hidden="true" />,
    },
  ];
  if (canManageCredentials) {
    tabs.push({
      id: 'integrations',
      label: 'Integrations',
      icon: <GenericProviderIcon className="webapp-tab-icon" />,
    });
  }
  const effectiveSegment = !canManageCredentials && segment === 'integrations' ? 'files' : segment;

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
                {tab.id === 'integrations' && pendingRequests.length > 0 && (
                  <span className="workspace-pending-badge" aria-label={`${pendingRequests.length} pending`}>
                    {pendingRequests.length}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </header>
      <div className="workspace-drawer-body">
        {tabs.map((tab) => (
          <div role="tabpanel" hidden={effectiveSegment !== tab.id} key={tab.id}>
            <WorkspacePanelContent
              panel={tab.id}
              pendingRequests={pendingRequests}
              canManageCredentials={canManageCredentials}
              {...panelProps}
              visible={open && effectiveSegment === tab.id}
            />
          </div>
        ))}
      </div>
    </aside>
  );
}
