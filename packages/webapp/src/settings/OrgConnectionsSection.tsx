import type { ConnectionView } from '@blitzos/schema';
import { useCallback, useEffect, useState } from 'react';
import type { ControlPlaneClient } from '../api';
import { ConfirmationDialog } from '../ConfirmationDialog';
import { caughtErrorMessage } from '../error-message';
import { CUSTODY_BADGE } from '../connections/custody-badge';

type OrgClient = Pick<ControlPlaneClient, 'listConnections' | 'deleteConnection'>;

/** The org credentials, revoke-only. Settings stopped being an add surface in
 * the flow inversion: admins configure a provider where they attach it — the
 * template create/edit screen — and this list is where a stored credential
 * gets taken away again. Rows without a sealed root (member-connect
 * declarations) are not credentials and do not show here. */
export function OrgConnectionsSection({ client }: { client: OrgClient }) {
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ConnectionView | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const { connections: rows } = await client.listConnections(signal);
      setConnections(rows.filter(
        (connection) => connection.orgCredential && connection.status === 'active',
      ));
      setError(null);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(caughtErrorMessage(caught, 'Organization connections failed to load.'));
    } finally {
      if (signal?.aborted !== true) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    const abort = new AbortController();
    void reload(abort.signal);
    return () => abort.abort();
  }, [reload]);

  const revoke = async (connection: ConnectionView) => {
    if (revoking !== null) return;
    setRevokeTarget(null);
    setRevoking(connection.name);
    setError(null);
    try {
      await client.deleteConnection(connection.name);
      await reload();
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Revoke failed.'));
    } finally {
      setRevoking(null);
    }
  };

  if (!loading && connections.length === 0 && error === null) return null;

  return (
    <section
      className="settings-credential-section"
      aria-label="Organization connections"
    >
      <div className="settings-section-heading">
        <div>
          <p>Organization</p>
          <h2>Admin-configured</h2>
        </div>
        {connections.length > 0 && <span>{connections.length} stored</span>}
      </div>
      <p className="settings-credential-state">
        One credential each, reaching every workspace that enables the
        provider. Add or replace one on the template page, where the provider
        is attached; revoking here cuts every workspace off immediately.
      </p>
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      {loading ? (
        <p className="settings-credential-state">Loading organization connections…</p>
      ) : (
        <div className="settings-credential-list">
          {connections.map((connection) => (
            <article className="settings-credential-row" key={connection.name}>
              <div>
                <div className="settings-credential-row__title">
                  <h3>{connection.name}</h3>
                  <span className="workspace-state-badge workspace-state-badge--active">
                    {CUSTODY_BADGE[connection.custody]}
                  </span>
                </div>
                <p>
                  Stored credential
                  {connection.proxyBaseUrl !== null && ` · ${connection.proxyBaseUrl}`}
                </p>
              </div>
              <div className="settings-row-actions">
                <button
                  className="webapp-action webapp-action--danger"
                  type="button"
                  disabled={revoking !== null}
                  onClick={() => setRevokeTarget(connection)}
                >{revoking === connection.name ? 'Revoking…' : 'Revoke'}</button>
              </div>
            </article>
          ))}
        </div>
      )}
      {revokeTarget && (
        <ConfirmationDialog
          title="Revoke this organization credential?"
          description={`Revoke ${revokeTarget.name} for the whole organization? Every workspace loses it immediately; add it back from the template page.`}
          confirmLabel="Revoke credential"
          onCancel={() => setRevokeTarget(null)}
          onConfirm={() => { void revoke(revokeTarget); }}
        />
      )}
    </section>
  );
}
