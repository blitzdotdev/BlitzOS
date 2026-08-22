import type {
  CatalogEntryView,
  ConnectionView,
  PutConnectionRequest,
} from '@blitzos/schema';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ControlPlaneClient } from '../api';
import { caughtErrorMessage } from '../error-message';

type AdminClient = Pick<
  ControlPlaneClient,
  'listConnectionCatalog' | 'listConnections' | 'putConnection'
>;

function field(data: FormData, name: string): string {
  return String(data.get(name) ?? '').trim();
}

/** The whole PUT body derives from the catalog view: the manifest already
 * decided custody, the placements, and the proxy header. The form only ever
 * contributes the two values no manifest can know — the root and, for proxy
 * custody, the instance URL. */
export function adminConnectionInput(
  entry: CatalogEntryView,
  data: FormData,
): PutConnectionRequest | null {
  const form = entry.adminForm;
  if (form === null) return null;
  const config: PutConnectionRequest['config'] = {
    placements: form.placements.map(({ kind, name, fill }) => ({ kind, name, fill })),
  };
  if (form.proxy !== null) {
    config.proxy = {
      base_url: field(data, 'baseUrl'),
      token_header: form.proxy.tokenHeader,
      token_prefix: form.proxy.tokenPrefix,
    };
  }
  return {
    provider: entry.id,
    kind: 'static',
    custody: entry.custody,
    config,
    root: field(data, 'root'),
  };
}

/** Org-wide provider configuration, the admin half of the connections story:
 * one credential stored here reaches every workspace that enables the
 * provider, with no per-member step. Mounted only for admins; the PUT route
 * enforces the same gate server-side. */
export function AdminConnectionsSection({ client }: { client: AdminClient }) {
  const [entries, setEntries] = useState<CatalogEntryView[]>([]);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formVersion, setFormVersion] = useState(0);

  const reloadConnections = useCallback(async () => {
    const { connections: rows } = await client.listConnections();
    setConnections(rows);
  }, [client]);

  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      client.listConnectionCatalog(abort.signal),
      client.listConnections(abort.signal),
    ]).then(
      ([catalog, listed]) => {
        setEntries(catalog.providers.filter((entry) => entry.adminForm !== null));
        setConnections(listed.connections);
        setLoading(false);
      },
      (caught) => {
        if (abort.signal.aborted) return;
        setLoading(false);
        setError(caughtErrorMessage(caught, 'Organization connections failed to load.'));
      },
    );
    return () => abort.abort();
  }, [client]);

  const configured = (entry: CatalogEntryView): boolean =>
    connections.some(
      (connection) => connection.name === entry.id && connection.status === 'active',
    );

  const choose = (entry: CatalogEntryView) => {
    setSelectedId((current) => (current === entry.id ? null : entry.id));
    setFormVersion((current) => current + 1);
    setError(null);
  };

  const submit = async (entry: CatalogEntryView, event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const form = event.currentTarget;
    const input = adminConnectionInput(entry, new FormData(form));
    if (input === null) return;
    setSaving(true);
    setError(null);
    try {
      await client.putConnection(entry.id, input);
      await reloadConnections();
      form.reset();
      setSelectedId(null);
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Saving the connection failed.'));
    } finally {
      setSaving(false);
    }
  };

  if (!loading && entries.length === 0 && error === null) return null;

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
        {entries.length > 0 && <span>{entries.length} available</span>}
      </div>
      <p className="settings-credential-state">
        Configured once here, these reach every workspace that enables them.
        Members do nothing — workspaces created from a template naming one get
        working credentials immediately.
      </p>
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      {loading ? (
        <p className="settings-credential-state">Loading organization connections…</p>
      ) : (
        <div className="settings-credential-list">
          {entries.map((entry) => {
            const form = entry.adminForm;
            if (form === null) return null;
            const active = selectedId === entry.id;
            const done = configured(entry);
            return (
              <article className="settings-credential-row" key={entry.id}>
                <div>
                  <div className="settings-credential-row__title">
                    <h3>{entry.title}</h3>
                    {done && (
                      <span className="workspace-state-badge workspace-state-badge--active">
                        configured
                      </span>
                    )}
                  </div>
                  <p>{entry.summary}</p>
                  {active && (
                    <form
                      className="connect-form"
                      key={`${entry.id}:${formVersion}`}
                      onSubmit={(event) => { void submit(entry, event); }}
                    >
                      {form.proxy !== null && (
                        <label className="connect-field connect-field--wide">
                          <span className="connect-field__label">{form.proxy.baseUrlLabel}</span>
                          <input name="baseUrl" type="url" required placeholder="https://" />
                        </label>
                      )}
                      <label className="connect-field connect-field--wide">
                        <span className="connect-field__label">{form.rootLabel}</span>
                        <input name="root" type="password" required autoComplete="new-password" />
                      </label>
                      <p className="connect-help connect-field--wide">{form.rootHelp}</p>
                      <div className="connect-actions connect-field--wide">
                        <button
                          className="webapp-action"
                          type="button"
                          onClick={() => setSelectedId(null)}
                        >Cancel</button>
                        <button
                          className="webapp-action webapp-action--primary"
                          type="submit"
                          disabled={saving}
                        >{saving ? 'Saving…' : done ? 'Replace credential' : 'Save'}</button>
                      </div>
                    </form>
                  )}
                </div>
                {!active && (
                  <div className="settings-row-actions">
                    <button
                      className="webapp-action"
                      type="button"
                      onClick={() => choose(entry)}
                    >{done ? 'Reconfigure' : 'Configure'}</button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
