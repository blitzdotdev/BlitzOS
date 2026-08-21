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
import { ConnectPicker, CUSTODY_BADGE } from './settings/ConnectPicker';
import { asJsonObject, isString } from './type-guards';
import { FolderIcon, GenericProviderIcon } from './WebAppIcons';

export const CREDENTIAL_POLL_INTERVAL_MS = 5_000;

export function portAge(firstSeenAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - firstSeenAt) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/** A workspace row prints its transport with the words the connect card prints
 * for custody: an `inject` lease is the cp column's `injected`. */
const MODE_BADGE = {
  inject: CUSTODY_BADGE.cp,
  proxy: CUSTODY_BADGE.proxy,
} satisfies Record<CredentialLeaseView['mode'], string>;

function isLive(lease: CredentialLeaseView, now: number): boolean {
  return lease.state === 'active' && lease.expiresAt > now;
}

/** One row per connection. Before mint learned to supersede, every credential
 * sync minted another lease and retired none, so workspaces in the wild carry
 * duplicates of the same connection. The live one is the truth; where nothing
 * is live the newest row still shows, so revoking here never blanks the panel. */
export function newestPerConnection(
  leases: readonly CredentialLeaseView[],
  now = Date.now(),
): CredentialLeaseView[] {
  const shown = new Map<string, CredentialLeaseView>();
  for (const lease of leases) {
    const held = shown.get(lease.connection);
    if (held === undefined) {
      shown.set(lease.connection, lease);
      continue;
    }
    const live = isLive(lease, now);
    if (live !== isLive(held, now)) {
      if (live) shown.set(lease.connection, lease);
      continue;
    }
    if (lease.issuedAt > held.issuedAt) shown.set(lease.connection, lease);
  }
  return [...shown.values()];
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
  readOnly,
}: {
  client: ControlPlaneClient;
  workspaceId: string;
  visible: boolean;
  readOnly?: boolean;
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
        setError(caughtErrorMessage(caught, 'Connections failed to load.'));
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
      setError(caughtErrorMessage(caught, 'Revoke failed.'));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section className="workspace-drawer-panel workspace-leases" aria-label="Workspace connections">
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      {loading ? (
        <p className="workspace-drawer-state">Loading connections…</p>
      ) : leases.length === 0 ? (
        <p className="workspace-drawer-state">Nothing is connected in this workspace yet.</p>
      ) : (
        <div className="workspace-credential-rows">
          {newestPerConnection(leases, now).map((lease) => {
            const state = lease.state === 'active' && lease.expiresAt <= now
              ? 'expired'
              : lease.state;
            return (
            <article className="workspace-credential-row" key={lease.id}>
              <div className="workspace-credential-row__title">
                <strong>{lease.connection}</strong>
                <span className={`workspace-state-badge workspace-state-badge--${state}`}>
                  {state}
                </span>
              </div>
              <p>{lease.scopes.length === 0 ? 'No named scopes' : lease.scopes.join(', ')}</p>
              <div className="workspace-credential-row__meta">
                <span>{MODE_BADGE[lease.mode]}</span>
                <time dateTime={new Date(lease.expiresAt).toISOString()}>
                  {state === 'active' ? expiryCountdown(lease.expiresAt, now) : state}
                </time>
              </div>
              {readOnly !== true && (
                <button
                  className="webapp-action workspace-credential-row__action"
                  type="button"
                  disabled={state !== 'active' || revoking !== null}
                  onClick={() => setConfirmation(lease)}
                >{revoking === lease.id ? 'Revoking…' : 'Revoke'}</button>
              )}
            </article>
            );
          })}
        </div>
      )}
      {confirmation && (
        <ConfirmationDialog
          title="Revoke this connection?"
          description={`Revoke ${confirmation.connection} access for this workspace immediately?`}
          confirmLabel="Revoke access"
          onCancel={() => setConfirmation(null)}
          onConfirm={() => { void revoke(confirmation); }}
        />
      )}
    </section>
  );
}

/** The connect inbox. A pending row is not a decision waiting on an approver —
 * it is an agent that wanted `@name` and found no grant behind it. An empty
 * inbox is a success, so it draws nothing; a failed load still speaks, because
 * an error is information the person does not otherwise have. */
export function WorkspaceRequestsPanel({
  requests,
  loadError,
  readOnly,
  onResolve,
  onConnect,
}: {
  requests: CredentialRequestView[];
  loadError?: string | null;
  readOnly?: boolean;
  onResolve: (request: CredentialRequestView, action: 'approve' | 'deny') => Promise<void>;
  onConnect?: (connectionName: string) => void;
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
    <section className="workspace-drawer-panel workspace-requests" aria-label="Workspace connect inbox">
      {(error ?? loadError) && <p className="webapp-form-message" role="alert">{error ?? loadError}</p>}
      {requests.length > 0 && (
        <div className="workspace-credential-rows">
          {requests.map((request) => (
            <article className="workspace-credential-row" key={request.id}>
              <div className="workspace-credential-row__title">
                <strong>@{request.connection_name}</strong>
                <span className="workspace-state-badge workspace-state-badge--active">wanted</span>
              </div>
              <p>{request.requested_scopes.length === 0
                ? 'An agent asked for this connection and found nothing behind it.'
                : `An agent asked for ${request.requested_scopes.join(', ')}.`}</p>
              <div className="workspace-credential-row__meta">
                <time dateTime={new Date(request.created_at).toISOString()}>
                  {new Date(request.created_at).toLocaleString()}
                </time>
              </div>
              {readOnly !== true && (
                <div className="workspace-credential-row__actions">
                  <button
                    className="webapp-action"
                    type="button"
                    disabled={resolving !== null}
                    onClick={() => { void resolve(request, 'deny'); }}
                  >Dismiss</button>
                  <button
                    className="webapp-action webapp-action--primary"
                    type="button"
                    disabled={resolving !== null}
                    onClick={() => onConnect?.(request.connection_name)}
                  >Connect</button>
                </div>
              )}
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

export function WorkspaceConnectionsPanel({
  client,
  workspaceId,
  visible,
  readOnly,
  pendingRequests,
  pendingRequestsError,
  onResolveRequest,
}: {
  client: ControlPlaneClient;
  workspaceId: string;
  visible: boolean;
  readOnly?: boolean;
  pendingRequests: CredentialRequestView[];
  pendingRequestsError?: string | null;
  onResolveRequest: (
    request: CredentialRequestView,
    action: 'approve' | 'deny',
  ) => Promise<void>;
}) {
  const [connecting, setConnecting] = useState<string | null>(null);
  // Nothing wanted is the everyday state, and a heading over an apology for
  // having nothing to say is worse than silence. The pending count on the
  // connections rail icon is what tells a person there is something here.
  const wanted = pendingRequests.length > 0 || (pendingRequestsError ?? null) !== null;
  return (
    <div className="workspace-connections">
      {wanted && (
        <>
          <h3 className="workspace-sect workspace-sect--pending">Wanted here</h3>
          <WorkspaceRequestsPanel
            requests={pendingRequests}
            loadError={pendingRequestsError}
            readOnly={readOnly}
            onResolve={onResolveRequest}
            onConnect={setConnecting}
          />
        </>
      )}
      {readOnly !== true && (
        <ConnectPicker
          client={client}
          requestedProvider={connecting}
          onConnected={() => {
            const pending = pendingRequests.find(
              (request) => request.connection_name === connecting,
            );
            setConnecting(null);
            // Connecting is the answer to the inbox entry: resolving it also
            // widens the workspace ceiling so the next mint succeeds.
            if (pending !== undefined) void onResolveRequest(pending, 'approve');
          }}
        />
      )}
      <h3 className="workspace-sect">Connections</h3>
      <WorkspaceLeasesPanel
        client={client}
        workspaceId={workspaceId}
        visible={visible}
        readOnly={readOnly}
      />
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
  /** Workspace sharing, not an org role: a viewer sees the panel but cannot
   * revoke a lease or connect on this workspace's behalf. */
  readOnly?: boolean;
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
  readOnly,
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
  return (
    <WorkspaceConnectionsPanel
      client={client}
      workspaceId={workspaceId}
      visible={visible}
      readOnly={readOnly}
      pendingRequests={pendingRequests}
      pendingRequestsError={pendingRequestsError}
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
    { id: 'files', label: 'Files', icon: <FolderIcon className="webapp-tab-icon" /> },
    {
      id: 'previews',
      label: 'teenyapps',
      icon: <span className="webapp-tab-icon mi-preview" aria-hidden="true" />,
    },
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
