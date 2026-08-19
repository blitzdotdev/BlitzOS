import type { CatalogEntryView, PutUserGrantRequest } from '@blitzos/schema';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ControlPlaneClient } from '../api';

import { caughtErrorMessage } from '../error-message';

const GENERIC_ID = 'generic';

/** Exactly what connecting needs. Narrow so the create-workspace dialog can
 * host the same component without taking the whole client surface. */
export type ConnectClient = Pick<
  ControlPlaneClient,
  'listConnectionCatalog' | 'putConnectionGrant' | 'connectStartUrl'
>;

function field(data: FormData, name: string): string {
  return String(data.get(name) ?? '').trim();
}

export function grantInput(
  entry: CatalogEntryView,
  data: FormData,
  scopes: readonly string[],
): PutUserGrantRequest {
  const input: PutUserGrantRequest = {
    manifestId: entry.id,
    token: field(data, 'token'),
    scopes: [...scopes],
  };
  const label = field(data, 'label');
  if (label) input.label = label;
  if (entry.needsVendorConfig) {
    const baseUrl = field(data, 'baseUrl');
    const baseUrlEnvName = field(data, 'baseUrlEnvName');
    input.vendor = { envName: field(data, 'envName') };
    if (baseUrl) input.vendor.baseUrl = baseUrl;
    if (baseUrl && baseUrlEnvName) input.vendor.baseUrlEnvName = baseUrlEnvName;
  }
  return input;
}

/** The one connect surface, hosted by both the workspace panel and settings.
 * There is no admin gate: the only account a member can connect is their own. */
export function ConnectPicker({
  client,
  requestedProvider,
  onConnected,
}: {
  client: ConnectClient;
  requestedProvider?: string | null;
  onConnected?: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogEntryView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formVersion, setFormVersion] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    void client.listConnectionCatalog(abort.signal).then(
      (response) => {
        setCatalog(response.providers);
        setLoading(false);
      },
      (caught) => {
        if (abort.signal.aborted) return;
        setLoading(false);
        setError(caughtErrorMessage(caught, 'Provider catalog failed to load.'));
      },
    );
    return () => abort.abort();
  }, [client]);

  const choose = useCallback((entry: CatalogEntryView, connectionName?: string) => {
    setSelectedId(entry.id);
    setName(connectionName ?? entry.id);
    setScopes(entry.scopes.filter((scope) => scope.default).map((scope) => scope.id));
    setFormVersion((current) => current + 1);
    setError(null);
  }, []);

  // A connect inbox entry names a connection, not a catalog id: an unknown
  // name is a generic connection the agent asked for by name.
  useEffect(() => {
    if (!requestedProvider || catalog.length === 0) return;
    const known = catalog.find((entry) => entry.id === requestedProvider);
    const entry = known ?? catalog.find((candidate) => candidate.id === GENERIC_ID);
    if (entry === undefined) return;
    choose(entry, requestedProvider);
  }, [catalog, choose, requestedProvider]);

  const selected = catalog.find((entry) => entry.id === selectedId) ?? null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || selected === null) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const provider = field(data, 'name') || selected.id;
    setSaving(true);
    setError(null);
    try {
      await client.putConnectionGrant(provider, grantInput(selected, data, scopes));
      form.reset();
      setSelectedId(null);
      onConnected?.();
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Connect failed.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-credential-section connect-picker" aria-label="Connect a provider">
      <div className="settings-section-heading">
        <div><p>Your account</p><h2>Connect</h2></div>
      </div>
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      {loading ? (
        <p className="settings-credential-state">Loading providers…</p>
      ) : (
        <div className="settings-template-grid">
          {catalog.map((entry) => (
            <button
              className={entry.id === selectedId
                ? 'settings-template-card settings-template-card--active'
                : 'settings-template-card'}
              type="button"
              key={entry.id}
              aria-pressed={entry.id === selectedId}
              onClick={() => choose(entry)}
            >
              <strong>{entry.title}</strong>
              <small>{entry.summary}</small>
            </button>
          ))}
        </div>
      )}

      {selected !== null && (
        <>
          {selected.scopes.length > 0 && (
            <fieldset className="connect-scopes">
              <legend>What this connection lets an agent do</legend>
              {selected.scopes.map((scope) => (
                <label key={scope.id}>
                  <input
                    type="checkbox"
                    name="scope"
                    value={scope.id}
                    checked={scopes.includes(scope.id)}
                    onChange={(event) => setScopes((current) => (
                      event.currentTarget.checked
                        ? [...new Set([...current, scope.id])]
                        : current.filter((entry) => entry !== scope.id)
                    ))}
                  />
                  <span><strong>{scope.title}</strong> — {scope.detail}</span>
                </label>
              ))}
            </fieldset>
          )}

          {selected.oauthAvailable && (
            <div className="connect-oauth">
              {selected.oauthConfigured ? (
                <a className="webapp-action webapp-action--primary" href={client.connectStartUrl(selected.id)}>
                  Connect with {selected.title}
                </a>
              ) : (
                <p className="webapp-form-message">
                  {selected.title} OAuth is not configured on this instance. Paste a token below, or
                  ask an operator to register the app and set its client secret.
                </p>
              )}
            </div>
          )}

          {selected.personalTokenLabel === null ? (
            <p className="settings-credential-state">
              {selected.title} issues no personal token. Connecting requires OAuth.
            </p>
          ) : (
            <form
              className="settings-connection-form"
              key={`${selected.id}:${formVersion}`}
              onSubmit={(event) => { void submit(event); }}
            >
              <label>
                Connection name
                <input
                  name="name"
                  required
                  value={name}
                  readOnly={!selected.needsVendorConfig}
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              </label>
              <label>Label (optional)<input name="label" placeholder="work account" /></label>
              {selected.needsVendorConfig && (
                <>
                  <label>Environment variable<input name="envName" required placeholder="SERVICE_API_KEY" /></label>
                  <label>Vendor base URL (optional)<input name="baseUrl" type="url" placeholder="https://api.example.com" /></label>
                  <label>Base URL variable (optional)<input name="baseUrlEnvName" placeholder="SERVICE_BASE_URL" /></label>
                </>
              )}
              <label className="settings-connection-form__wide">
                {selected.personalTokenLabel}
                <input name="token" type="password" required autoComplete="new-password" />
              </label>
              <p className="settings-secret-paste settings-connection-form__wide">
                {selected.personalTokenHelp}
              </p>
              <div className="settings-row-actions settings-connection-form__wide">
                <button className="webapp-action" type="button" onClick={() => setSelectedId(null)}>Cancel</button>
                <button className="webapp-action webapp-action--primary" type="submit" disabled={saving}>
                  {saving ? 'Connecting…' : 'Connect'}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
