import type { CredentialRequestView, IntegrationView } from '@blitzos/schema';
import { useCallback, useEffect, useState } from 'react';
import type { ControlPlaneClient, CredentialRequestState } from '../api';
import { caughtErrorMessage } from '../error-message';

export type StatefulCredentialRequest = CredentialRequestView & {
  state: CredentialRequestState;
};

export function RequestsPanel({
  client,
  onConfigure,
}: {
  client: ControlPlaneClient;
  onConfigure: (integrationName: string) => void;
}) {
  const [requests, setRequests] = useState<StatefulCredentialRequest[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const states: CredentialRequestState[] = ['pending', 'approved', 'denied'];
      const [configured, ...feeds] = await Promise.all([
        client.listIntegrations(signal),
        ...states.map((state) => client.listCredentialRequests(signal, state)),
      ]);
      if (signal?.aborted) return;
      setIntegrations(configured.integrations);
      setRequests(feeds.flatMap((feed, index) => feed.requests.map((request) => ({
        ...request,
        state: states[index]!,
      }))).sort((left, right) => right.created_at - left.created_at));
      setError(null);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(caughtErrorMessage(caught, 'Access requests failed to load.'));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    const request = new AbortController();
    void reload(request.signal);
    return () => request.abort();
  }, [reload]);

  const resolve = async (request: StatefulCredentialRequest, action: 'approve' | 'deny') => {
    if (resolving !== null || request.state !== 'pending') return;
    setResolving(request.id);
    setError(null);
    try {
      if (action === 'approve') await client.approveCredentialRequest(request.id);
      else await client.denyCredentialRequest(request.id);
      setRequests((current) => current.map((entry) => entry.id === request.id
        ? { ...entry, state: action === 'approve' ? 'approved' : 'denied' }
        : entry));
    } catch (caught) {
      setError(caughtErrorMessage(caught, `Request ${action} failed.`));
    } finally {
      setResolving(null);
    }
  };

  const configured = new Set(integrations.map(({ name }) => name));
  const pendingCount = requests.filter(({ state }) => state === 'pending').length;

  return (
    <section className="settings-panel settings-requests" role="tabpanel" aria-label="Requests">
      <header className="settings-panel-header">
        <div>
          <p>Global approval feed</p>
          <h1>Requests</h1>
          <span>Credential access across every workspace, including resolved decisions.</span>
        </div>
        <span className="settings-count-badge">{pendingCount} pending</span>
      </header>
      {error && <p className="cockpit-form-message" role="alert">{error}</p>}
      {loading ? (
        <p className="settings-credential-state">Loading access requests…</p>
      ) : requests.length === 0 ? (
        <p className="settings-credential-state">No credential access requests.</p>
      ) : (
        <div className="settings-credential-list">
          {requests.map((request) => (
            <article className="settings-credential-row settings-request-row" key={`${request.state}:${request.id}`}>
              <div>
                <div className="settings-credential-row__title">
                  <h3>{request.integration_name}</h3>
                  <span className={`workspace-state-badge workspace-state-badge--${request.state}`}>
                    {request.state}
                  </span>
                </div>
                <p>workspace · {request.workspace_id}</p>
                <small>{request.requested_scopes.length === 0
                  ? 'Integration access · no named scopes'
                  : request.requested_scopes.join(', ')}</small>
                <time dateTime={new Date(request.created_at).toISOString()}>{new Date(request.created_at).toLocaleString()}</time>
              </div>
              {request.state === 'pending' && (
                <div className="settings-row-actions">
                  {!configured.has(request.integration_name) && (
                    <button className="cockpit-action" type="button" onClick={() => onConfigure(request.integration_name)}>
                      Add integration
                    </button>
                  )}
                  <button className="cockpit-action" type="button" disabled={resolving !== null} onClick={() => { void resolve(request, 'deny'); }}>Deny</button>
                  <button className="cockpit-action cockpit-action--primary" type="button" disabled={resolving !== null || !configured.has(request.integration_name)} onClick={() => { void resolve(request, 'approve'); }}>
                    {resolving === request.id ? 'Working…' : 'Approve'}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
