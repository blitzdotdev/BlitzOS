import type { ProviderHealthView, UserGrantView } from '@blitzos/schema';
import { useCallback, useEffect, useState } from 'react';
import type { ControlPlaneClient } from '../api';
import { ConfirmationDialog } from '../ConfirmationDialog';
import { caughtErrorMessage } from '../error-message';
import { PanelHeader } from './primitives';

function healthLabel(health: ProviderHealthView | undefined): string | null {
  if (health === undefined || health.checkedAt === null) return null;
  const minutes = Math.floor((Date.now() - health.checkedAt) / 60_000);
  const age = minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
  return `${health.state === 'healthy' ? 'checked' : 'failing'} ${age}`;
}

/** Settings → Connections after the flow inversion: revoke and rotate only.
 * Nothing is added here any more — members connect inside a workspace (the
 * drawer's connections panel). What remains is one person's grants with
 * revoke and an OAuth re-run for rotation. Org-shared secrets are not
 * connections at all: they live in the org Credentials panel. */
export function ConnectionsPanel({ client }: { client: ControlPlaneClient }) {
  const [grants, setGrants] = useState<UserGrantView[]>([]);
  const [health, setHealth] = useState<ProviderHealthView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<UserGrantView | null>(null);

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
      <PanelHeader
        eyebrow="Your identities"
        title="Connections"
        detail="Agents in workspaces you own act as you on these providers."
      />
      {error && <p className="webapp-form-message" role="alert">{error}</p>}

      {/* Account scope: an authorization is not a connection. Connecting
        * happens inside a workspace, in its connections panel — the one place
        * a lease can be minted. This page only takes things away. */}
      <section className="cfg-section" aria-label="Authorized providers">
        <div className="settings-section-heading">
          <div className="cfg-section-head">
            <h2 className="cfg-title">Authorized</h2>
            <p className="cfg-desc">Providers you authorized</p>
          </div>
          <span>{grants.length} total</span>
        </div>
        {loading ? (
          <p className="settings-credential-state">Loading connections…</p>
        ) : grants.length === 0 ? (
          <p className="settings-credential-state">
            Nothing authorized yet. Connect a provider from a workspace's
            connections panel; the grant it creates shows up here.
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
                    {grant.kind === 'oauth' && (
                      // Rotation for an OAuth grant is re-running the dance;
                      // no form needed, so the one add-shaped action left is a
                      // plain link into the provider round trip.
                      <a
                        className="webapp-action"
                        href={client.connectStartUrl(grant.provider)}
                      >Re-auth</a>
                    )}
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

      {revokeTarget && (
        <ConfirmationDialog
          title="Revoke this connection?"
          description={`Revoke ${revokeTarget.provider}? Every workspace holding a lease from it loses access immediately. Pasted keys must be pasted again to reconnect.`}
          confirmLabel="Revoke connection"
          onCancel={() => setRevokeTarget(null)}
          onConfirm={() => { void revoke(revokeTarget); }}
        />
      )}
    </section>
  );
}
