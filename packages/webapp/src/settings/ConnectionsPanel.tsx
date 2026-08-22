import type { ProviderHealthView, UserGrantView } from '@blitzos/schema';
import { useCallback, useEffect, useState } from 'react';
import type { ControlPlaneClient } from '../api';
import { ConfirmationDialog } from '../ConfirmationDialog';
import { caughtErrorMessage } from '../error-message';
import { AdminConnectionsSection } from './AdminConnectionsSection';
import { ConnectPicker } from './ConnectPicker';

function healthLabel(health: ProviderHealthView | undefined): string | null {
  if (health === undefined || health.checkedAt === null) return null;
  const minutes = Math.floor((Date.now() - health.checkedAt) / 60_000);
  const age = minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
  return `${health.state === 'healthy' ? 'checked' : 'failing'} ${age}`;
}

/** Your grants across every provider. There are no org grants, so this page
 * shows exactly one person's connections and nobody else's. */
export function ConnectionsPanel({
  client,
  requestedName,
  admin = false,
}: {
  client: ControlPlaneClient;
  requestedName?: string;
  /** Shows the org-wide section; the PUT route enforces the same gate. */
  admin?: boolean;
}) {
  const [grants, setGrants] = useState<UserGrantView[]>([]);
  const [health, setHealth] = useState<ProviderHealthView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<UserGrantView | null>(null);
  const [reconnect, setReconnect] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [granted, checked] = await Promise.all([
        client.listConnectionGrants(),
        client.listProviderHealth().catch(() => ({ providers: [] })),
      ]);
      setGrants(granted.grants);
      setHealth(checked.providers);
      setError(null);
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Connections failed to load.'));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void reload(); }, [reload]);

  const revoke = async (grant: UserGrantView) => {
    if (revoking !== null) return;
    setRevokeTarget(null);
    setRevoking(grant.provider);
    setError(null);
    try {
      await client.deleteConnectionGrant(grant.provider);
      await reload();
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Revoke failed.'));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section className="settings-panel settings-connections" role="tabpanel" aria-label="Connections">
      <header className="settings-panel-header">
        <div>
          <p>Your identities</p>
          <h1>Connections</h1>
          <span>Agents in workspaces you own act as you on these providers.</span>
        </div>
      </header>
      {error && <p className="webapp-form-message" role="alert">{error}</p>}

      {/* Account scope: a grant authorizes, it does not connect. Connecting
        * gives one workspace a lease, and only a workspace can hold one. */}
      <section className="settings-credential-section" aria-label="Authorized providers">
        <div className="settings-section-heading">
          <div><p>Personal grants</p><h2>Authorized</h2></div>
          <span>{grants.length} total</span>
        </div>
        {loading ? (
          <p className="settings-credential-state">Loading connections…</p>
        ) : grants.length === 0 ? (
          <p className="settings-credential-state">
            Nothing authorized yet. Authorize a provider below and any workspace you own
            can connect it in one click.
          </p>
        ) : (
          <div className="settings-credential-list">
            {grants.map((grant) => {
              const state = healthLabel(health.find(({ provider }) => provider === grant.provider));
              return (
                <article className="settings-credential-row" key={grant.provider}>
                  <div>
                    <div className="settings-credential-row__title">
                      <h3>{grant.provider}</h3>
                      <span className="workspace-state-badge workspace-state-badge--active">
                        {grant.kind === 'pat' ? 'token' : 'oauth'}
                      </span>
                    </div>
                    <p>{grant.label ?? grant.manifestId}</p>
                    <small>{grant.scopes.length === 0 ? 'no named scopes' : grant.scopes.join(', ')}</small>
                    {state !== null && <small>{state}</small>}
                  </div>
                  <div className="settings-row-actions">
                    <button
                      className="webapp-action"
                      type="button"
                      onClick={() => setReconnect(grant.provider)}
                    >Re-auth</button>
                    <button
                      className="webapp-action webapp-action--danger"
                      type="button"
                      disabled={revoking !== null}
                      onClick={() => setRevokeTarget(grant)}
                    >{revoking === grant.provider ? 'Revoking…' : 'Revoke'}</button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <ConnectPicker
        client={client}
        requestedProvider={reconnect ?? requestedName ?? null}
        onConnected={() => {
          setReconnect(null);
          void reload();
        }}
      />

      {admin && <AdminConnectionsSection client={client} />}

      {revokeTarget && (
        <ConfirmationDialog
          title="Revoke this connection?"
          description={`Revoke ${revokeTarget.provider}? Every workspace holding a lease from it loses access immediately.`}
          confirmLabel="Revoke connection"
          onCancel={() => setRevokeTarget(null)}
          onConfirm={() => { void revoke(revokeTarget); }}
        />
      )}
    </section>
  );
}
