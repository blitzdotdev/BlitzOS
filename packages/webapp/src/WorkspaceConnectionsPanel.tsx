import type { CredentialEventView, CredentialRequestView } from '@blitzos/schema';
import { useCallback, useEffect, useState } from 'react';
import type { ControlPlaneClient } from './api';
import { caughtErrorMessage } from './error-message';
import { ProviderGlyph } from './connections/ProviderGlyph';
import { useConnectedProviders } from './connections/use-connected-providers';
import { WorkspaceProviderRows } from './connections/WorkspaceProviderRows';
import { settingsPath } from './sessions-page-state';
import { asJsonObject, isString } from './type-guards';

export function portAge(firstSeenAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - firstSeenAt) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/** An in-box agent asked for this panel by provider, via
 * `blitz connections open`. A fresh object arrives per focus event, so the
 * panel re-selects even when the same provider is asked for twice. */
export type ConnectionsPanelFocus = { provider: string; at: number };

/** Every card in this panel wears the same stamp: `Aug 27, 14:02`. A wanted
 * card and a log card used to print a full `toLocaleString`, which wrapped in a
 * 320px drawer and read as a different kind of card than the provider tile
 * beside it. */
function cardTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
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
        <div className="wsc-list">
          {requests.map((request) => (
            <article className="wsc-tile wsc-tile--static wsc-tile--wanted" key={request.id}>
              <div className="wsc-tile__head">
                <ProviderGlyph className="wsc-tile__glyph" provider={request.connection_name} />
                <span className="wsc-tile__name">
                  <strong>@{request.connection_name}</strong>
                  <span>{request.requested_scopes.length === 0
                    ? 'An agent asked for this connection and found nothing behind it.'
                    : `An agent asked for ${request.requested_scopes.join(', ')}.`}</span>
                </span>
                <time
                  className="wsc-tile__when"
                  dateTime={new Date(request.created_at).toISOString()}
                >{cardTime(request.created_at)}</time>
              </div>
              <div className="wsc-tile__foot">
                <span className="wsc-tile__state">Wanted</span>
                {readOnly !== true && (
                  <div className="wsc-tile__actions">
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
        <div className="wsc-list">
          {events.map((event) => (
            <article className="wsc-tile wsc-tile--static wsc-tile--log" key={event.id}>
              <div className="wsc-tile__head">
                <span className="wsc-tile__name">
                  <strong>{event.event}</strong>
                  <span>{eventActor(event) ?? 'system'}</span>
                </span>
                <time
                  className="wsc-tile__when"
                  dateTime={new Date(event.createdAt).toISOString()}
                >{cardTime(event.createdAt)}</time>
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
  readOnly,
  pendingRequests,
  pendingRequestsError,
  workspaceConnections,
  connectionsFocus,
  onResolveRequest,
}: {
  client: ControlPlaneClient;
  workspaceId: string;
  readOnly?: boolean;
  pendingRequests: CredentialRequestView[];
  pendingRequestsError?: string | null;
  /** Provider names this workspace's allow-list holds. An agent inside the box
   * may pull exactly these, and nothing else. */
  workspaceConnections?: readonly string[];
  /** The latest `blitz connections open` focus: opens that provider's row. */
  connectionsFocus?: ConnectionsPanelFocus | null;
  onResolveRequest: (
    request: CredentialRequestView,
    action: 'approve' | 'deny',
  ) => Promise<void>;
}) {
  const [connected, noteConnected] = useConnectedProviders(workspaceConnections ?? []);
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

  /** A provider just became usable here. The inbox entry that asked for it is
   * the same question, so answering one answers the other. Nothing is pushed
   * at the box: the next token ask reads the allow-list this write just
   * changed. */
  const onConnected = useCallback((connectionName: string) => {
    noteConnected(connectionName, true);
    const pending = pendingRequests.find(
      (request) => request.connection_name === connectionName,
    );
    if (pending !== undefined) void onResolveRequest(pending, 'approve');
  }, [noteConnected, onResolveRequest, pendingRequests]);

  const onDisconnected = useCallback((connectionName: string) => {
    noteConnected(connectionName, false);
  }, [noteConnected]);

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
      {/* The scope, once, where the list starts. Every control below is
        * workspace-scoped, and saying so here is what lets a row's own copy
        * stay short: Disconnect no longer has to explain what it disconnects. */}
      <p className="wsc-scope">
        What agents may use in this workspace. Disconnecting affects this
        workspace only. Account sign-ins live in{' '}
        <a href={settingsPath('connections')}>Settings</a>.
      </p>
      <WorkspaceProviderRows
        client={client}
        workspaceId={workspaceId}
        connected={connected}
        focusProvider={opened?.name ?? null}
        focusVersion={opened?.version ?? 0}
        readOnly={readOnly}
        onConnected={onConnected}
        onDisconnected={onDisconnected}
      />
    </div>
  );
}
