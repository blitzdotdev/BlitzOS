import type { CredentialEventView, CredentialLeaseView, CredentialRequestView } from '@blitzos/schema';
import { useCallback, useEffect, useState } from 'react';
import type { ControlPlaneClient } from './api';
import { caughtErrorMessage } from './error-message';
import { pushCredentialSync } from './connections/credential-sync';
import { WorkspaceProviderRows } from './connections/WorkspaceProviderRows';
import { asJsonObject, isString } from './type-guards';

export const CREDENTIAL_POLL_INTERVAL_MS = 5_000;

export function portAge(firstSeenAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - firstSeenAt) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

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

/** What this workspace holds, read once. */
export type WorkspaceLeaseFeed = {
  /** One row per connection: the live lease where there is one. */
  rows: CredentialLeaseView[];
  loading: boolean;
  error: string | null;
  now: number;
  revoking: string | null;
  revoke: (lease: CredentialLeaseView) => Promise<void>;
  noteLease: (lease: CredentialLeaseView) => void;
};

/** The lease poll, hoisted out of the rows that read it. A provider row needs
 * the same fact the revoke path does — whether this workspace holds a live
 * lease — and two readers of one fact owe the server one request. */
export function useWorkspaceLeases(
  client: Pick<ControlPlaneClient, 'listLeases' | 'revokeLease'>,
  workspaceId: string,
  visible: boolean,
): WorkspaceLeaseFeed {
  const [leases, setLeases] = useState<CredentialLeaseView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
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

  /** A lease minted from the grid shows up before the next poll confirms it:
   * the server already wrote it, and supersede means the poll can only agree. */
  const noteLease = useCallback((lease: CredentialLeaseView) => {
    setLeases((current) => [lease, ...current]);
  }, []);

  const rows = newestPerConnection(leases, now);

  return { rows, loading, error, now, revoking, revoke, noteLease };
}

/** An in-box agent asked for this panel by provider, via
 * `blitz connections open`. A fresh object arrives per focus event, so the
 * panel re-selects even when the same provider is asked for twice. */
export type ConnectionsPanelFocus = { provider: string; at: number };

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

/** What this workspace has logged, read once. */
export type WorkspaceEventFeed = {
  events: CredentialEventView[];
  error: string | null;
};

/** The credential log for this workspace. The host needs the count to decide
 * whether there is a section at all, so the read lives out here with it. */
export function useWorkspaceCredentialEvents(
  client: Pick<ControlPlaneClient, 'listCredentialEvents'>,
  workspaceId: string,
  visible: boolean,
): WorkspaceEventFeed {
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
  return { events, error };
}

export function WorkspaceEventsPanel({ events, error }: WorkspaceEventFeed) {
  return (
    <section className="workspace-drawer-panel" aria-label="Workspace credential events">
      {error !== null && <p className="webapp-form-message" role="alert">{error}</p>}
      {events.length > 0 && (
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
  stipulatedConnections,
  connectionsFocus,
  filesBase,
  onResolveRequest,
}: {
  client: ControlPlaneClient;
  workspaceId: string;
  visible: boolean;
  readOnly?: boolean;
  pendingRequests: CredentialRequestView[];
  pendingRequestsError?: string | null;
  /** Connection names the workspace ceiling enables (template-stipulated plus
   * named-at-create). They head the provider list and carry a badge. */
  stipulatedConnections?: readonly string[];
  /** The latest `blitz connections open` focus: opens that provider's row. */
  connectionsFocus?: ConnectionsPanelFocus | null;
  /** The box's file surface, which is also where its gateway answers. Null
   * until the workspace is reachable; the delivery push is skipped then, and
   * the box picks the credential up on its own next sync. */
  filesBase?: string | null;
  onResolveRequest: (
    request: CredentialRequestView,
    action: 'approve' | 'deny',
  ) => Promise<void>;
}) {
  const leases = useWorkspaceLeases(client, workspaceId, visible);
  // Recent activity is hidden per product ruling 2026-08-24; the hook above it,
  // WorkspaceEventsPanel, and the control-plane route all stay.
  const { noteLease } = leases;
  const stipulated = stipulatedConnections ?? [];
  // Which provider row to open, and a version so asking twice for the same
  // one re-opens a row the person closed. Two things ask: an agent's
  // `blitz connections open`, and Connect on a request in the inbox.
  const [opened, setOpened] = useState<{ name: string; version: number } | null>(null);
  const ask = useCallback((name: string) => {
    setOpened((current) => ({ name, version: (current?.version ?? 0) + 1 }));
  }, []);
  useEffect(() => {
    if (connectionsFocus == null) return;
    ask(connectionsFocus.provider);
  }, [ask, connectionsFocus]);

  /** A provider just went live here. Two things follow: the connect request
   * that asked for it is answered, and the box is told to fetch. Without the
   * push the box only learns on its own cadence, which is throttled by a
   * freshness window — the member sat looking at a connected provider whose
   * tools stayed dark. It is best-effort by design: the box's own sync is
   * still the guarantee, this only makes it prompt. */
  const connected = useCallback((connectionName: string) => {
    const pending = pendingRequests.find(
      (request) => request.connection_name === connectionName,
    );
    // Connecting is the answer to the inbox entry: resolving it also widens
    // the workspace ceiling so the next mint succeeds.
    if (pending !== undefined) void onResolveRequest(pending, 'approve');
    if (filesBase != null) void pushCredentialSync(filesBase);
  }, [filesBase, onResolveRequest, pendingRequests]);

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
            onConnect={ask}
          />
        </>
      )}
      <h3 className="workspace-sect">Connections</h3>
      {leases.error !== null && (
        <p className="webapp-form-message" role="alert">{leases.error}</p>
      )}
      {leases.loading && <p className="workspace-drawer-state">Loading connections…</p>}
      <WorkspaceProviderRows
        client={client}
        workspaceId={workspaceId}
        stipulated={stipulated}
        leases={leases.rows}
        now={leases.now}
        focusProvider={opened?.name ?? null}
        focusVersion={opened?.version ?? 0}
        readOnly={readOnly}
        revoking={leases.revoking}
        onRevokeLease={leases.revoke}
        onLeaseMinted={noteLease}
        onConnected={connected}
      />
    </div>
  );
}
