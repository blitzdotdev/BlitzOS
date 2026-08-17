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
import type { LivePort } from './preview';
import type { WorkspaceDrawerSegment } from './storage';
import { asJsonObject, isString } from './type-guards';

export const CREDENTIAL_POLL_INTERVAL_MS = 5_000;

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

function WorkspaceEventsPanel({
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

export function WorkspaceDrawer({
  client,
  workspaceId,
  mobile,
  open,
  width,
  segment,
  pendingRequests,
  pendingRequestsError,
  files,
  onWidthChange,
  onSegmentChange,
  onResolveRequest,
  canManageCredentials,
  livePorts,
  onOpenPreview,
}: {
  client: ControlPlaneClient;
  workspaceId: string;
  mobile: boolean;
  open: boolean;
  width: number;
  segment: WorkspaceDrawerSegment;
  pendingRequests: CredentialRequestView[];
  pendingRequestsError?: string | null;
  files: ReactNode;
  onWidthChange: (width: number) => void;
  onSegmentChange: (segment: WorkspaceDrawerSegment) => void;
  onResolveRequest: (
    request: CredentialRequestView,
    action: 'approve' | 'deny',
  ) => Promise<void>;
  canManageCredentials: boolean;
  livePorts: LivePort[];
  onOpenPreview: (port: number) => void;
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
    onWidthChange(Math.max(200, Math.min(480, origin.width + origin.x - event.clientX)));
  };

  const tabs: Array<{ id: WorkspaceDrawerSegment; label: string }> = [
    { id: 'files', label: 'Files' },
    { id: 'previews', label: 'Previews' },
  ];
  if (canManageCredentials) tabs.push({ id: 'integrations', label: 'Integrations' });
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
        {tabs.map((tab) => (
          <button
            className={effectiveSegment === tab.id ? 'workspace-drawer-segment workspace-drawer-segment--active' : 'workspace-drawer-segment'}
            type="button"
            role="tab"
            aria-selected={effectiveSegment === tab.id}
            key={tab.id}
            onClick={() => onSegmentChange(tab.id)}
          >
            {tab.label}
            {tab.id === 'integrations' && pendingRequests.length > 0 && (
              <span className="workspace-pending-badge" aria-label={`${pendingRequests.length} pending`}>
                {pendingRequests.length}
              </span>
            )}
          </button>
        ))}
      </header>
      <div className="workspace-drawer-body">
        <div role="tabpanel" hidden={effectiveSegment !== 'files'}>{files}</div>
        <div role="tabpanel" hidden={effectiveSegment !== 'previews'}>
          <section className="workspace-drawer-panel workspace-previews" aria-label="Live preview ports">
            {livePorts.length === 0
              ? (
                <p className="workspace-drawer-state">
                  No live ports yet — start a dev server in the terminal and it
                  shows up here.
                </p>
              )
              : livePorts.map((entry) => (
                <button
                  className="workspace-preview-row"
                  type="button"
                  key={entry.port}
                  onClick={() => onOpenPreview(entry.port)}
                >
                  <span className="mi-preview" aria-hidden="true" />
                  <span className="workspace-preview-port">:{entry.port}</span>
                  <span className="workspace-preview-process">{entry.process}</span>
                </button>
              ))}
          </section>
        </div>
        {canManageCredentials && <div role="tabpanel" hidden={effectiveSegment !== 'integrations'}>
          <WorkspaceRequestsPanel
            requests={pendingRequests}
            loadError={pendingRequestsError}
            onResolve={onResolveRequest}
          />
          <WorkspaceLeasesPanel
            client={client}
            workspaceId={workspaceId}
            visible={open && effectiveSegment === 'integrations'}
          />
          <WorkspaceEventsPanel
            client={client}
            workspaceId={workspaceId}
            visible={open && effectiveSegment === 'integrations'}
          />
        </div>}
      </div>
    </aside>
  );
}
