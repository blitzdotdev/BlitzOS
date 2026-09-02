import type { CredentialRequestView, GrantProposalView } from '@blitzos/schema';
import { useCallback, useEffect, useState } from 'react';
import type { ControlPlaneClient, CredentialRequestState } from '../api';
import { caughtErrorMessage } from '../error-message';

export type StatefulCredentialRequest = CredentialRequestView & {
  state: CredentialRequestState;
};

export function RequestsPanel({
  client,
  onOpenWorkspace,
  onReviewProposal,
}: {
  client: ControlPlaneClient;
  /** Connecting happens inside the workspace that filed the request — its
   * connections panel carries the same inbox entry with a Connect that
   * resolves it. This inbox is the org-wide view; the action is a door. */
  onOpenWorkspace: (workspaceId: string) => void;
  /** A pending grant proposal closed without a decision stays pending
   * (plans/ORG-CREDENTIALS.md §7a); this reopens its dialog. */
  onReviewProposal?: (proposalId: string) => void;
}) {
  const [requests, setRequests] = useState<StatefulCredentialRequest[]>([]);
  const [proposals, setProposals] = useState<GrantProposalView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const states: CredentialRequestState[] = ['pending', 'approved', 'denied'];
      const [feeds, pendingProposals] = await Promise.all([
        Promise.all(states.map((state) => client.listCredentialRequests(signal, state))),
        client.listGrantProposals(signal, 'pending'),
      ]);
      if (signal?.aborted) return;
      setRequests(feeds.flatMap((feed, index) => feed.requests.map((request) => ({
        ...request,
        state: states[index]!,
      }))).sort((left, right) => right.created_at - left.created_at));
      setProposals(pendingProposals.proposals);
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

  const dismiss = async (request: StatefulCredentialRequest) => {
    if (resolving !== null || request.state !== 'pending') return;
    setResolving(request.id);
    setError(null);
    try {
      await client.denyCredentialRequest(request.id);
      setRequests((current) => current.map((entry) => entry.id === request.id
        ? { ...entry, state: 'denied' }
        : entry));
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Dismiss failed.'));
    } finally {
      setResolving(null);
    }
  };

  const pendingCount = requests.filter(({ state }) => state === 'pending').length;

  return (
    <section className="settings-panel settings-requests" role="tabpanel" aria-label="Requests">
      <header className="settings-panel-header">
        <div>
          <p>Connect inbox</p>
          <h1>Requests</h1>
          <span>Connections agents asked for and did not find, across every workspace.</span>
        </div>
        <span className="settings-count-badge">{pendingCount} pending</span>
      </header>
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      {proposals.length > 0 && (
        <section className="cfg-section" aria-label="Grant proposals">
          <div className="cfg-section-head">
            <h2 className="cfg-title">Grant proposals</h2>
            <p className="cfg-desc">Credential grant changes an agent proposed and nobody has decided on yet.</p>
          </div>
          <div className="settings-credential-list">
            {proposals.map((proposal) => (
              <article className="settings-credential-row settings-request-row" key={proposal.id}>
                <div>
                  <div className="settings-credential-row__title">
                    <h3>{proposal.proposed.length} grant change{proposal.proposed.length === 1 ? '' : 's'}</h3>
                    <span className="workspace-state-badge workspace-state-badge--pending">pending</span>
                  </div>
                  <p>{[...new Set(proposal.proposed.map(({ name }) => name))].join(', ')}</p>
                  {proposal.reason !== null && <small>“{proposal.reason}”</small>}
                  <time dateTime={new Date(proposal.createdAt).toISOString()}>{new Date(proposal.createdAt).toLocaleString()}</time>
                </div>
                {onReviewProposal !== undefined && (
                  <div className="settings-row-actions">
                    <button
                      className="webapp-action webapp-action--primary"
                      type="button"
                      onClick={() => onReviewProposal(proposal.id)}
                    >Review</button>
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      )}
      {loading ? (
        <p className="settings-credential-state">Loading access requests…</p>
      ) : requests.length === 0 ? (
        <p className="settings-credential-state">No agent has asked for a connection.</p>
      ) : (
        <div className="settings-credential-list">
          {requests.map((request) => (
            <article className="settings-credential-row settings-request-row" key={`${request.state}:${request.id}`}>
              <div>
                <div className="settings-credential-row__title">
                  <h3>@{request.connection_name}</h3>
                  <span className={`workspace-state-badge workspace-state-badge--${request.state}`}>
                    {request.state}
                  </span>
                </div>
                <p>workspace · {request.workspace_id}</p>
                <small>{request.requested_scopes.length === 0
                  ? 'An agent asked for this connection and found nothing behind it.'
                  : `An agent asked for ${request.requested_scopes.join(', ')}.`}</small>
                <time dateTime={new Date(request.created_at).toISOString()}>{new Date(request.created_at).toLocaleString()}</time>
              </div>
              {request.state === 'pending' && (
                <div className="settings-row-actions">
                  <button
                    className="webapp-action"
                    type="button"
                    disabled={resolving !== null}
                    onClick={() => { void dismiss(request); }}
                  >{resolving === request.id ? 'Working…' : 'Dismiss'}</button>
                  <button
                    className="webapp-action webapp-action--primary"
                    type="button"
                    onClick={() => onOpenWorkspace(request.workspace_id)}
                  >Open workspace</button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
