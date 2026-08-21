import type {
  CatalogEntryView,
  Custody,
  PutUserGrantRequest,
  UserGrantView,
} from '@blitzos/schema';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ControlPlaneClient } from '../api';

import { caughtErrorMessage } from '../error-message';

const GENERIC_ID = 'generic';

/** Where the key sits once a credential is minted. The words match what a
 * workspace connection row already prints, so the badge teaches the same
 * vocabulary in both places. */
export const CUSTODY_BADGE = {
  cp: 'injected',
  broker: 'brokered',
  proxy: 'proxied',
} satisfies Record<Custody, string>;

/** What a grant is called in a sentence. `pat` covers every pasted key, not
 * just the ones a vendor calls a personal access token. */
function grantKindLabel(grant: UserGrantView): string {
  return grant.kind === 'oauth' ? 'oauth' : 'API key';
}

/** Information wants a glyph, not a box: an outlined mark keeps a notice from
 * reading as a disabled input. */
function InfoGlyph() {
  return (
    <svg className="connect-note__glyph" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.1" /><path d="M8 7.3v3.5" /><path d="M8 5.1h.01" /></svg>
  );
}

/** Exactly what connecting needs. Narrow so the create-workspace dialog can
 * host the same component without taking the whole client surface. */
export type ConnectClient = Pick<
  ControlPlaneClient,
  | 'listConnectionCatalog'
  | 'listConnectionGrants'
  | 'putConnectionGrant'
  | 'connectStartUrl'
>;

function field(data: FormData, name: string): string {
  return String(data.get(name) ?? '').trim();
}

/** Submitting over an existing grant replaces it, so the button says so. */
function submitLabel(connected: boolean, saving: boolean): string {
  if (connected) return saving ? 'Reconnecting…' : 'Reconnect';
  return saving ? 'Connecting…' : 'Connect';
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
  const [grants, setGrants] = useState<UserGrantView[]>([]);
  const [grantsVersion, setGrantsVersion] = useState(0);
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

  // The catalog says what a person could connect; their grants say what they
  // already did. A failure here costs the "Connected" badge and nothing else,
  // so it never blocks connecting or steals the catalog's error line.
  useEffect(() => {
    const abort = new AbortController();
    void client.listConnectionGrants(abort.signal).then(
      (response) => setGrants(response.grants),
      () => undefined,
    );
    return () => abort.abort();
  }, [client, grantsVersion]);

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
  /** A grant is keyed by the connection name the person chose, which is the
   * catalog id for every entry but the generic one. */
  const grantFor = (entry: CatalogEntryView): UserGrantView | null =>
    grants.find((grant) => grant.provider === entry.id) ?? null;
  const selectedGrant = selected === null ? null : grantFor(selected);

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
      setGrantsVersion((current) => current + 1);
      onConnected?.();
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Connect failed.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-credential-section connect-picker" aria-label="Connect a provider">
      <div className="settings-section-heading connect-picker__heading">
        <div><p>Your account</p><h2>Connect</h2></div>
        {catalog.length > 0 && <span>{catalog.length} available</span>}
      </div>
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      {loading ? (
        <p className="connect-state">Loading providers…</p>
      ) : (
        <div className="connect-grid">
          {catalog.map((entry) => {
            const active = entry.id === selectedId;
            const connected = grantFor(entry) !== null;
            return (
              <button
                className={active ? 'connect-card connect-card--active' : 'connect-card'}
                type="button"
                key={entry.id}
                aria-pressed={active}
                onClick={() => choose(entry)}
              >
                <span className="connect-card__title">{entry.title}</span>
                <span className="connect-card__summary">{entry.summary}</span>
                <span className="connect-card__badges">
                  {connected && <span className="connect-badge connect-badge--connected">Connected</span>}
                  {entry.oauthAvailable && <span className="connect-badge">OAuth</span>}
                  {entry.personalTokenLabel !== null && <span className="connect-badge">API key</span>}
                  <span className="connect-badge connect-badge--quiet">{CUSTODY_BADGE[entry.custody]}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {selected !== null && (
        <div className="connect-detail">
          <div className="connect-detail__head">
            <h3>{selected.title}</h3>
            <p>{selected.summary}</p>
            {selectedGrant !== null && (
              <p className="connect-detail__connected">
                Connected · {grantKindLabel(selectedGrant)}
              </p>
            )}
          </div>

          {selected.scopes.length > 0 && (
            <fieldset className="connect-scopes">
              <legend className="connect-scopes__legend">What this connection lets an agent do</legend>
              <div className="connect-scopes__list">
                {selected.scopes.map((scope) => (
                  <label className="connect-scope" key={scope.id}>
                    <input
                      className="connect-scope__box"
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
                    <span className="connect-scope__copy">
                      <span className="connect-scope__title">{scope.title}</span>
                      <span className="connect-scope__detail">{scope.detail}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {selected.oauthAvailable && (selected.oauthConfigured ? (
            <div className="connect-actions">
              <a
                className="webapp-action webapp-action--primary connect-cta"
                href={client.connectStartUrl(selected.id)}
              >
                {selectedGrant === null ? `Connect with ${selected.title}` : `Reconnect ${selected.title}`}
              </a>
            </div>
          ) : (
            <p className="connect-note">
              <InfoGlyph />
              <span>
                {selected.title} OAuth is not configured on this instance. Paste a token below, or
                ask an operator to register the app and set its client secret.
              </span>
            </p>
          ))}

          {selected.personalTokenLabel === null ? (
            <p className="connect-note">
              <InfoGlyph />
              <span>{selected.title} issues no personal token. Connecting requires OAuth.</span>
            </p>
          ) : (
            <form
              className="connect-form"
              key={`${selected.id}:${formVersion}`}
              onSubmit={(event) => { void submit(event); }}
            >
              <label className="connect-field">
                <span className="connect-field__label">Connection name</span>
                <input
                  name="name"
                  required
                  value={name}
                  readOnly={!selected.needsVendorConfig}
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              </label>
              <label className="connect-field">
                <span className="connect-field__label">Label (optional)</span>
                <input name="label" placeholder="work account" />
              </label>
              {selected.needsVendorConfig && (
                <>
                  <label className="connect-field">
                    <span className="connect-field__label">Environment variable</span>
                    <input name="envName" required placeholder="SERVICE_API_KEY" />
                  </label>
                  <label className="connect-field">
                    <span className="connect-field__label">Vendor base URL (optional)</span>
                    <input name="baseUrl" type="url" placeholder="https://api.example.com" />
                  </label>
                  <label className="connect-field">
                    <span className="connect-field__label">Base URL variable (optional)</span>
                    <input name="baseUrlEnvName" placeholder="SERVICE_BASE_URL" />
                  </label>
                </>
              )}
              <label className="connect-field connect-field--wide">
                <span className="connect-field__label">{selected.personalTokenLabel}</span>
                <input name="token" type="password" required autoComplete="new-password" />
              </label>
              {selected.personalTokenHelp !== null && (
                <p className="connect-help connect-field--wide">{selected.personalTokenHelp}</p>
              )}
              <div className="connect-actions connect-field--wide">
                <button className="webapp-action" type="button" onClick={() => setSelectedId(null)}>Cancel</button>
                <button className="webapp-action webapp-action--primary" type="submit" disabled={saving}>
                  {submitLabel(selectedGrant !== null, saving)}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
