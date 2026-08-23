import type {
  CatalogEntryView,
  ConnectionView,
  UserGrantView,
} from '@blitzos/schema';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ControlPlaneClient } from '../api';
import { CUSTODY_BADGE } from '../connections/custody-badge';
import {
  grantInput,
  lockedInstanceBaseUrl,
  ProviderConnectSurface,
} from '../connections/ProviderConnectSurface';

import { caughtErrorMessage } from '../error-message';

const GENERIC_ID = 'generic';

export { CUSTODY_BADGE };

/** What a grant is called in a sentence. `pat` covers every pasted key, not
 * just the ones a vendor calls a personal access token. */
function grantKindLabel(grant: UserGrantView): string {
  return grant.kind === 'oauth' ? 'oauth' : 'API key';
}

/** Exactly what connecting needs. Narrow so the create-workspace dialog can
 * host the same component without taking the whole client surface. */
export type ConnectClient = Pick<
  ControlPlaneClient,
  | 'listConnectionCatalog'
  | 'listConnectionGrants'
  | 'listConnections'
  | 'putConnectionGrant'
  | 'connectStartUrl'
>;

function field(data: FormData, name: string): string {
  return String(data.get(name) ?? '').trim();
}

/** Two independent facts ride the same outline, so the class list says both and
 * the stylesheet decides which colour wins. */
function cardClass(active: boolean, connected: boolean): string {
  return [
    'connect-card',
    connected ? 'connect-card--connected' : '',
    active ? 'connect-card--active' : '',
  ].filter((part) => part !== '').join(' ');
}

/** The workspace this picker is connecting, when it is inside one. Connecting
 * means giving a workspace a lease, which happens in the workspace's own
 * connections panel — so a picker without this prop is authorizing an account,
 * and says so in every word it prints. */
export type ConnectWorkspace = {
  id: string;
  /** Connection names holding a live lease here. The only thing that makes a
   * card read Connected. */
  connections: ReadonlySet<string>;
  /** Mints the lease for a provider the account has already authorized. */
  connect: (connectionName: string) => Promise<void>;
};

/** The provider round trip, named for what it accomplishes where it is
 * offered: a workspace ends up connected, an account ends up authorized. */
function oauthLabel(inWorkspace: boolean, title: string, authorized: boolean): string {
  if (inWorkspace) return `Connect with ${title}`;
  return authorized ? `Reauthorize ${title}` : `Authorize ${title}`;
}

/** What the token form's submit button does. In a workspace it connects; in
 * settings the same submit replaces the key an account already holds. */
function submitLabel(
  workspace: ConnectWorkspace | undefined,
  authorized: boolean,
  saving: boolean,
): string {
  if (workspace !== undefined) return saving ? 'Connecting…' : 'Connect';
  if (authorized) return saving ? 'Replacing…' : 'Replace key';
  return saving ? 'Authorizing…' : 'Authorize';
}

/** The account-scope authorize surface: one card per catalog provider, and the
 * provider's own connect surface under the selected one.
 *
 * Connecting a workspace does not happen here any more — the workspace's
 * connections panel expands the same surface inline in a provider row, which
 * is where a member is when they need it. This stays the account view, and
 * keeps the `workspace` prop for a host that wants both in one place. */
export function ConnectPicker({
  client,
  requestedProvider,
  requestVersion = 0,
  workspace,
  onConnected,
}: {
  client: ConnectClient;
  requestedProvider?: string | null;
  /** Bump to re-select `requestedProvider` even when the name is unchanged. */
  requestVersion?: number;
  /** Present only inside a workspace. Absent, this picker authorizes an
   * account: real, useful, and not a connection — a grant is the plumbing that
   * makes connecting instant, never the thing itself. */
  workspace?: ConnectWorkspace;
  onConnected?: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogEntryView[]>([]);
  const [grants, setGrants] = useState<UserGrantView[]>([]);
  const [orgConnections, setOrgConnections] = useState<ConnectionView[]>([]);
  const [grantsVersion, setGrantsVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');
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

  // The org's declared rows carry the instance URL for instance-hosted
  // vendors, so a member's paste form can prefill it instead of asking.
  // Same failure posture as grants: losing this costs only the prefill.
  useEffect(() => {
    const abort = new AbortController();
    void client.listConnections(abort.signal).then(
      (response) => setOrgConnections(response.connections),
      () => undefined,
    );
    return () => abort.abort();
  }, [client, grantsVersion]);

  const choose = useCallback((entry: CatalogEntryView, connectionName?: string) => {
    setSelectedId(entry.id);
    setName(connectionName ?? entry.id);
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
  }, [catalog, choose, requestedProvider, requestVersion]);

  const selected = catalog.find((entry) => entry.id === selectedId) ?? null;
  /** A grant is keyed by the connection name the person chose, which is the
   * catalog id for every entry but the generic one. */
  const grantFor = (entry: CatalogEntryView): UserGrantView | null =>
    grants.find((grant) => grant.provider === entry.id) ?? null;
  const selectedGrant = selected === null ? null : grantFor(selected);
  /** The one meaning of the word. Outside a workspace nothing is connected,
   * because there is no workspace to hold the lease. */
  const isConnected = (entry: CatalogEntryView): boolean =>
    workspace !== undefined && workspace.connections.has(entry.id);
  const selectedConnected = selected !== null && isConnected(selected);

  const finish = () => {
    setSelectedId(null);
    setGrantsVersion((current) => current + 1);
    onConnected?.();
  };

  /** The account already authorized this provider, so connecting is one call
   * and no form: the grant is plumbing whose whole job is making this instant. */
  const connectNow = async (entry: CatalogEntryView) => {
    if (saving || workspace === undefined) return;
    setSaving(true);
    setError(null);
    try {
      await workspace.connect(entry.id);
      finish();
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Connect failed.'));
    } finally {
      setSaving(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || selected === null) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const provider = field(data, 'name') || selected.id;
    setSaving(true);
    setError(null);
    try {
      await client.putConnectionGrant(provider, grantInput(selected, data));
      // A key pasted inside a workspace was pasted in order to connect it, so
      // the lease follows the grant without a second click.
      if (workspace !== undefined) await workspace.connect(provider);
      form.reset();
      finish();
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Connect failed.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-credential-section connect-picker" aria-label="Connect a provider">
      <div className="settings-section-heading connect-picker__heading">
        <div>
          <p>{workspace === undefined ? 'Your account' : 'This workspace'}</p>
          <h2>{workspace === undefined ? 'Authorize' : 'Connect'}</h2>
        </div>
        {catalog.length > 0 && <span>{catalog.length} available</span>}
      </div>
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      {loading ? (
        <p className="connect-state">Loading providers…</p>
      ) : (
        <div className="connect-grid">
          {catalog.map((entry) => {
            const active = entry.id === selectedId;
            const connected = isConnected(entry);
            // Only where connecting cannot happen does authorization get a
            // badge of its own; in a workspace it is plumbing, and a card that
            // is not connected looks like every other unconnected card.
            const authorized = workspace === undefined && grantFor(entry) !== null;
            return (
              <button
                className={cardClass(active, connected || authorized)}
                type="button"
                key={entry.id}
                aria-pressed={active}
                onClick={() => choose(entry)}
              >
                {active && <span className="connect-card__check" aria-hidden="true">✓</span>}
                <span className="connect-card__title">{entry.title}</span>
                <span className="connect-card__summary">{entry.summary}</span>
                <span className="connect-card__badges">
                  {connected && <span className="connect-badge connect-badge--connected">Connected</span>}
                  {authorized && <span className="connect-badge connect-badge--authorized">Authorized</span>}
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
            {selectedConnected && (
              <p className="connect-detail__connected">
                Connected in this workspace · revoke it in Connections below to disconnect.
              </p>
            )}
            {selectedGrant !== null && !selectedConnected && (
              <p className="connect-detail__authorized">
                Authorized · {grantKindLabel(selectedGrant)}
              </p>
            )}
          </div>

          {selectedConnected ? (
            <div className="connect-actions">
              <button
                className="webapp-action"
                type="button"
                onClick={() => setSelectedId(null)}
              >Close</button>
            </div>
          ) : workspace !== undefined && selectedGrant !== null ? (
            <div className="connect-actions">
              <button
                className="webapp-action"
                type="button"
                onClick={() => setSelectedId(null)}
              >Cancel</button>
              <button
                className="webapp-action webapp-action--primary connect-cta"
                type="button"
                disabled={saving}
                onClick={() => { void connectNow(selected); }}
              >{saving ? 'Connecting…' : 'Connect'}</button>
            </div>
          ) : (
            <ProviderConnectSurface
              entry={selected}
              connectionName={name}
              onConnectionNameChange={setName}
              lockedBaseUrl={lockedInstanceBaseUrl(selected, orgConnections)}
              oauthHref={selected.oauthConfigured
                ? client.connectStartUrl(selected.id, workspace?.id)
                : null}
              oauthLabel={oauthLabel(workspace !== undefined, selected.title, selectedGrant !== null)}
              submitLabel={submitLabel(workspace, selectedGrant !== null, saving)}
              saving={saving}
              formKey={`${selected.id}:${String(formVersion)}`}
              onSubmit={(event) => { void submit(event); }}
              onCancel={() => setSelectedId(null)}
            />
          )}
        </div>
      )}
    </section>
  );
}
