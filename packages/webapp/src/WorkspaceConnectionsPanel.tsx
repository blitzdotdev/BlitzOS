import type { CredentialEventView, CredentialLeaseView, CredentialRequestView } from '@blitzos/schema';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ControlPlaneClient } from './api';
import { ConfirmationDialog } from './ConfirmationDialog';
import { caughtErrorMessage } from './error-message';
import { ConnectPicker, CUSTODY_BADGE, type ConnectWorkspace } from './settings/ConnectPicker';
import { asJsonObject, isString } from './type-guards';

export const CREDENTIAL_POLL_INTERVAL_MS = 5_000;

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

/** What this workspace holds, read once. */
export type WorkspaceLeaseFeed = {
  /** One row per connection: the live lease where there is one. */
  rows: CredentialLeaseView[];
  /** The connections holding a live lease in this workspace, by name. */
  live: ReadonlySet<string>;
  loading: boolean;
  error: string | null;
  now: number;
  revoking: string | null;
  revoke: (lease: CredentialLeaseView) => Promise<void>;
  noteLease: (lease: CredentialLeaseView) => void;
};

/** The lease poll, hoisted out of the section that lists it. The connect grid
 * needs the same fact to tell a connection that is live here from an account
 * grant that has not landed here yet, and two readers of one fact owe the
 * server one request. */
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
  // The grid reads membership, not identity. Keying the set on its own names
  // keeps the prop steady through the once-a-second clock tick.
  const liveNames = rows.filter((lease) => isLive(lease, now))
    .map((lease) => lease.connection).sort().join('\n');
  const live = useMemo(
    () => new Set(liveNames === '' ? [] : liveNames.split('\n')),
    [liveNames],
  );

  return { rows, live, loading, error, now, revoking, revoke, noteLease };
}

/** The workspace's own connections. An empty list is not a section: a heading
 * over an apology for holding nothing is worse than the silence of a workspace
 * that plainly holds no live lease. The host decides that; this draws what
 * the feed holds, and a failed load still speaks. */
export function WorkspaceLeasesPanel({
  feed,
  readOnly,
}: {
  feed: WorkspaceLeaseFeed;
  readOnly?: boolean;
}) {
  const { rows, loading, error, now, revoking, revoke } = feed;
  const [confirmation, setConfirmation] = useState<CredentialLeaseView | null>(null);

  return (
    <section className="workspace-drawer-panel workspace-leases" aria-label="Workspace connections">
      {error !== null && <p className="webapp-form-message" role="alert">{error}</p>}
      {loading && <p className="workspace-drawer-state">Loading connections…</p>}
      {rows.length > 0 && (
        <div className="workspace-credential-rows">
          {rows.map((lease) => {
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
          onConfirm={() => {
            setConfirmation(null);
            void revoke(confirmation);
          }}
        />
      )}
    </section>
  );
}

/** An in-box agent asked for this panel by provider, via
 * `blitz connections open`. A fresh object arrives per focus event, so the
 * panel re-selects even when the same provider is asked for twice. */
export type ConnectionsPanelFocus = { provider: string; at: number };

/** The template's stipulated providers as status rows: each reads off
 * whether its lease is live. Drawn from the workspace ceiling, not the lease
 * list, so a provider with no live lease yet still has a row to click. Same
 * row furniture as the lease list below it. */
export function WorkspaceStipulatedPanel({
  stipulated,
  live,
  focusProvider,
  readOnly,
  onConnect,
}: {
  stipulated: readonly string[];
  live: ReadonlySet<string>;
  focusProvider: string | null;
  readOnly?: boolean;
  onConnect: (provider: string) => void;
}) {
  return (
    <section
      className="workspace-drawer-panel workspace-leases"
      aria-label="Template connections"
    >
      <div className="workspace-credential-rows">
        {stipulated.map((provider) => {
          const leaseLive = live.has(provider);
          const focused = focusProvider === provider;
          return (
            <article
              className={`workspace-credential-row${focused ? ' workspace-credential-row--focus' : ''}`}
              key={provider}
            >
              <div className="workspace-credential-row__title">
                <strong>{provider}</strong>
                <span
                  className={`workspace-state-badge workspace-state-badge--${leaseLive ? 'active' : 'pending'}`}
                >{leaseLive ? 'connected' : 'needs you'}</span>
              </div>
              <p>{leaseLive
                ? 'Live in this workspace.'
                : 'This workspace names it. Its tools stay dark until you connect.'}</p>
              {readOnly !== true && !leaseLive && (
                <button
                  className="webapp-action webapp-action--primary workspace-credential-row__action"
                  type="button"
                  onClick={() => onConnect(provider)}
                >Connect</button>
              )}
            </article>
          );
        })}
      </div>
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
  onResolveRequest,
}: {
  client: ControlPlaneClient;
  workspaceId: string;
  visible: boolean;
  readOnly?: boolean;
  pendingRequests: CredentialRequestView[];
  pendingRequestsError?: string | null;
  /** Connection names the workspace ceiling enables (template-stipulated plus
   * named-at-create); each gets a status row that reads off whether its lease
   * is live. */
  stipulatedConnections?: readonly string[];
  /** The latest `blitz connections open` focus: selects that provider in the
   * connect grid and highlights its stipulated row. */
  connectionsFocus?: ConnectionsPanelFocus | null;
  onResolveRequest: (
    request: CredentialRequestView,
    action: 'approve' | 'deny',
  ) => Promise<void>;
}) {
  // The asked-for provider plus a version, so a repeat ask for the same name
  // still re-opens the card the person cancelled.
  const [connecting, setConnecting] = useState<{ name: string; version: number } | null>(null);
  const ask = useCallback((name: string) => {
    setConnecting((current) => ({ name, version: (current?.version ?? 0) + 1 }));
  }, []);
  const leases = useWorkspaceLeases(client, workspaceId, visible);
  const { events, error: eventsError } = useWorkspaceCredentialEvents(client, workspaceId, visible);
  const { live, noteLease } = leases;
  const stipulated = stipulatedConnections ?? [];
  // Each focus event is a fresh object, so asking for the same provider twice
  // still re-selects it after the person closed the card.
  useEffect(() => {
    if (connectionsFocus == null) return;
    ask(connectionsFocus.provider);
  }, [ask, connectionsFocus]);
  const connectWorkspace = useMemo<ConnectWorkspace>(() => ({
    id: workspaceId,
    connections: live,
    connect: async (connectionName: string) => {
      const { lease } = await client.mintWorkspaceConnection(workspaceId, connectionName);
      noteLease(lease);
    },
  }), [client, live, noteLease, workspaceId]);
  // Nothing wanted is the everyday state, and a heading over an apology for
  // having nothing to say is worse than silence. The pending count on the
  // connections rail icon is what tells a person there is something here.
  const wanted = pendingRequests.length > 0 || (pendingRequestsError ?? null) !== null;
  // Every section keeps that rule. A workspace with no live lease and
  // nothing logged is a page with a connect grid on it and no apologies. A
  // failed load still draws, because an error is information; so does the
  // first read, because "not yet known" is not the same as "nothing".
  const connections = leases.loading || leases.error !== null || leases.rows.length > 0;
  const activity = eventsError !== null || events.length > 0;
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
      {stipulated.length > 0 && (
        <>
          <h3 className="workspace-sect">From the template</h3>
          <WorkspaceStipulatedPanel
            stipulated={stipulated}
            live={live}
            focusProvider={connectionsFocus?.provider ?? null}
            readOnly={readOnly}
            onConnect={ask}
          />
        </>
      )}
      {readOnly !== true && (
        <ConnectPicker
          client={client}
          requestedProvider={connecting?.name ?? null}
          requestVersion={connecting?.version ?? 0}
          // Connecting is a thing that happens to a workspace, so the grid gets
          // the workspace: what it already holds, and how to give it one more.
          workspace={connectWorkspace}
          onConnected={() => {
            const pending = pendingRequests.find(
              (request) => request.connection_name === connecting?.name,
            );
            setConnecting(null);
            // Connecting is the answer to the inbox entry: resolving it also
            // widens the workspace ceiling so the next mint succeeds.
            if (pending !== undefined) void onResolveRequest(pending, 'approve');
          }}
        />
      )}
      {connections && (
        <>
          <h3 className="workspace-sect">Connections</h3>
          <WorkspaceLeasesPanel feed={leases} readOnly={readOnly} />
        </>
      )}
      {activity && (
        <>
          <h3 className="workspace-sect">Recent activity</h3>
          <WorkspaceEventsPanel events={events} error={eventsError} />
        </>
      )}
    </div>
  );
}
