import type {
  CatalogEntryView,
  ConnectionView,
  ProviderHealthView,
  UserGrantView,
} from '@blitzos/schema';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ControlPlaneClient } from '../api';
import { ConfirmationDialog } from '../ConfirmationDialog';
import {
  grantInput,
  lockedInstanceBaseUrl,
  ProviderConnectSurface,
} from '../connections/ProviderConnectSurface';
import { connectMethod } from '../connections/connect-method';
import { ProviderGlyph } from '../connections/ProviderGlyph';
import { caughtErrorMessage } from '../error-message';
import { PanelHeader } from './primitives';

function healthLabel(health: ProviderHealthView | undefined): string | null {
  if (health === undefined || health.checkedAt === null) return null;
  const minutes = Math.floor((Date.now() - health.checkedAt) / 60_000);
  const age = minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
  return `${health.state === 'healthy' ? 'checked' : 'failing'} ${age}`;
}

/** "signed in Sep 1". The one fact a row can state about a grant the member
 * may not remember making — a template stipulates providers at create time,
 * so a connection can predate the member ever opening this page. */
function signedIn(grant: UserGrantView): string {
  return `signed in ${new Date(grant.createdAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })}`;
}

/** Settings → Connections: the account's own identities, and nothing else.
 *
 * Two sections and no third. Connected is what this member authorized, with
 * the two verbs that change it; Available is every other catalog provider,
 * each tile saying how that provider connects. What an agent WANTED is not a
 * section here any more — a pending request pops the connect dialog in the
 * workspace that raised it (`ConnectApprovalDialog`), where the person is.
 */
export function ConnectionsPanel({ client }: { client: ControlPlaneClient }) {
  const [catalog, setCatalog] = useState<CatalogEntryView[]>([]);
  const [grants, setGrants] = useState<UserGrantView[]>([]);
  const [orgConnections, setOrgConnections] = useState<ConnectionView[]>([]);
  const [health, setHealth] = useState<ProviderHealthView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<UserGrantView | null>(null);
  // The tile a paste provider opened, and a version so re-opening the same
  // one resets the uncontrolled fields.
  const [pasting, setPasting] = useState<{ entry: CatalogEntryView; version: number } | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [granted, providers, checked, connections] = await Promise.all([
        client.listConnectionGrants(),
        client.listConnectionCatalog(),
        client.listProviderHealth().catch(() => ({ providers: [] })),
        client.listConnections().catch(() => ({ connections: [] })),
      ]);
      setGrants(granted.grants);
      setCatalog(providers.providers);
      setHealth(checked.providers);
      setOrgConnections(connections.connections);
      setError(null);
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Connections failed to load.'));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void reload(); }, [reload]);

  const disconnect = async (grant: UserGrantView) => {
    if (disconnecting !== null) return;
    setDisconnectTarget(null);
    setDisconnecting(grant.provider);
    setError(null);
    try {
      await client.deleteConnectionGrant(grant.provider);
      await reload();
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Disconnect failed.'));
    } finally {
      setDisconnecting(null);
    }
  };

  const paste = async (entry: CatalogEntryView, event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setSaving(true);
    setError(null);
    try {
      // A grant is always filed under the catalog id; the control plane
      // refuses any other name, which is why the form's name field is
      // read-only.
      await client.putConnectionGrant(entry.id, grantInput(entry, data));
      form.reset();
      setPasting(null);
      await reload();
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Connect failed.'));
    } finally {
      setSaving(false);
    }
  };

  const title = (provider: string): string =>
    catalog.find((entry) => entry.id === provider)?.title ?? provider;
  // Everything the catalog offers that this member has not authorized. A grant
  // for a provider the catalog does not know still draws a connected row —
  // the member made it, and only this page can take it away.
  const available = catalog.filter(
    (entry) => !grants.some((grant) => grant.provider === entry.id),
  );

  return (
    <section className="settings-panel settings-connections" role="tabpanel" aria-label="Connections">
      <PanelHeader eyebrow="Account" title="Connections" />
      {error !== null && <p className="webapp-form-message" role="alert">{error}</p>}

      <section className="cfg-section" aria-label="Connected providers">
        <div className="settings-section-heading">
          <div className="cfg-section-head">
            <h2 className="cfg-title">Connected · {grants.length}</h2>
          </div>
        </div>
        {loading ? (
          <p className="settings-credential-state">Loading connections…</p>
        ) : grants.length === 0 ? (
          <p className="settings-credential-state">Nothing connected.</p>
        ) : (
          <div className="settings-credential-list">
            {grants.map((grant) => {
              const state = healthLabel(health.find(({ provider }) => provider === grant.provider));
              return (
                <article className="settings-credential-row conn-row" key={grant.provider}>
                  <ProviderGlyph className="conn-mark" provider={grant.provider} />
                  <div>
                    <div className="settings-credential-row__title">
                      <h3>{title(grant.provider)}</h3>
                    </div>
                    <small>{state === null ? signedIn(grant) : `${signedIn(grant)} · ${state}`}</small>
                  </div>
                  <div className="settings-row-actions">
                    <span className="conn-chip">{grant.kind === 'pat' ? 'token' : 'oauth'}</span>
                    {grant.kind === 'oauth' && (
                      // Rotation for an OAuth grant is re-running the dance;
                      // no form needed, so the one add-shaped action left is a
                      // plain link into the provider round trip.
                      <a className="webapp-action" href={client.connectStartUrl(grant.provider)}>Re-auth</a>
                    )}
                    <button
                      className="webapp-action webapp-action--danger"
                      type="button"
                      disabled={disconnecting !== null}
                      onClick={() => setDisconnectTarget(grant)}
                    >{disconnecting === grant.provider ? 'Disconnecting…' : 'Disconnect'}</button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="cfg-section" aria-label="Available providers">
        <div className="settings-section-heading">
          <div className="cfg-section-head">
            <h2 className="cfg-title">Available</h2>
          </div>
        </div>
        {!loading && available.length === 0 ? (
          <p className="settings-credential-state">Everything in the catalog is connected.</p>
        ) : (
          <div className="connect-grid">
            {available.map((entry) => {
              const method = connectMethod(entry);
              const open = pasting?.entry.id === entry.id;
              // The tile IS the action for the two paths a member can walk
              // alone. The other two report a state, so pressing them would
              // promise something this page cannot do.
              if (method.kind === 'oauth') {
                return (
                  <a
                    className="connect-card"
                    key={entry.id}
                    href={client.connectStartUrl(entry.id)}
                  >
                    <ProviderGlyph className="conn-mark" provider={entry.id} />
                    <span className="connect-card__title">{entry.title}</span>
                    <span className="connect-card__summary">{method.label}</span>
                  </a>
                );
              }
              return (
                <button
                  className={`connect-card${open ? ' connect-card--active' : ''}`}
                  key={entry.id}
                  type="button"
                  aria-expanded={method.kind === 'token' ? open : undefined}
                  disabled={method.kind !== 'token'}
                  onClick={() => setPasting((current) => (
                    current?.entry.id === entry.id
                      ? null
                      : { entry, version: (current?.version ?? 0) + 1 }
                  ))}
                >
                  <ProviderGlyph className="conn-mark" provider={entry.id} />
                  <span className="connect-card__title">{entry.title}</span>
                  <span className="connect-card__summary">{method.label}</span>
                </button>
              );
            })}
          </div>
        )}
        {pasting !== null && (
          <ProviderConnectSurface
            entry={pasting.entry}
            connectionName={pasting.entry.id}
            lockedBaseUrl={lockedInstanceBaseUrl(pasting.entry, orgConnections)}
            oauthHref={null}
            oauthLabel={`Connect with ${pasting.entry.title}`}
            submitLabel="Connect"
            saving={saving}
            formKey={`${pasting.entry.id}:${String(pasting.version)}`}
            onSubmit={(event) => { void paste(pasting.entry, event); }}
            onCancel={() => setPasting(null)}
          />
        )}
      </section>

      {disconnectTarget !== null && (
        <ConfirmationDialog
          title="Disconnect this provider?"
          description={`Disconnect ${title(disconnectTarget.provider)}? Every workspace holding a lease from it loses access immediately. Pasted keys must be pasted again to reconnect.`}
          confirmLabel="Disconnect"
          onCancel={() => setDisconnectTarget(null)}
          onConfirm={() => { void disconnect(disconnectTarget); }}
        />
      )}
    </section>
  );
}
