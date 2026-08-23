import type {
  CatalogEntryView,
  ConnectionView,
  CredentialLeaseView,
  UserGrantView,
} from '@blitzos/schema';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ControlPlaneClient } from '../api';
import { caughtErrorMessage } from '../error-message';
import { ModalOverlay } from '../ModalOverlay';
import { settingsPath } from '../sessions-page-state';
import { CUSTODY_BADGE } from './custody-badge';
import {
  grantInput,
  lockedInstanceBaseUrl,
  ProviderConnectSurface,
} from './ProviderConnectSurface';

export type ProviderRowsClient = Pick<
  ControlPlaneClient,
  | 'listConnectionCatalog'
  | 'listConnectionGrants'
  | 'listConnections'
  | 'putConnectionGrant'
  | 'connectStartUrl'
  | 'mintWorkspaceConnection'
  | 'revokeLease'
>;

/** One provider, everything this workspace knows about it. */
type ProviderRow = {
  /** The connection name: the catalog id for every entry but a generic
   * connection an agent asked for by name. */
  name: string;
  title: string;
  entry: CatalogEntryView | null;
  stipulated: boolean;
  lease: CredentialLeaseView | null;
  grant: UserGrantView | null;
};

/** A row has two states, and no third. The workspace holds a live lease, or it
 * does not.
 *
 * The panel used to name four shades of not-connected — delivering…, not here
 * yet, needs a key, needs you. Each was true, and together they asked a member
 * to learn our credential model before they could press one button. */
function isConnected(row: ProviderRow, now: number): boolean {
  return row.lease !== null
    && row.lease.state === 'active'
    && row.lease.expiresAt > now;
}

/** A credential already stands behind this provider, so Connect is a mint and
 * not a form: either this member authorized it on their own account, or an
 * admin stored one org credential for everybody. */
function isBacked(
  row: ProviderRow,
  orgConnections: readonly ConnectionView[],
): boolean {
  if (row.grant !== null) return true;
  return orgConnections.some((connection) => connection.name === row.name
    && connection.status === 'active'
    && connection.orgCredential);
}

/** "authorized by you · Aug 21". The workspace mints from its owner's grants
 * at create time by design, so a member who never touched this panel can find
 * a provider already connected. Saying when they authorized it is what turns
 * that from a surprise into a fact. */
function provenance(grant: UserGrantView): string {
  const when = new Date(grant.createdAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `authorized by you · ${when}`;
}

/** Revoking a lease and revoking a grant are different acts with different
 * blast radii, and the old panel offered only the first while describing the
 * second. Naming both, in one place, is the fix. */
function DisconnectChooser({
  name,
  onWorkspace,
  onCancel,
}: {
  name: string;
  onWorkspace: () => void;
  onCancel: () => void;
}) {
  return (
    <ModalOverlay onDismiss={onCancel}>
      <section
        className="webapp-confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Disconnect ${name}`}
      >
        <header className="webapp-confirmation-header"><h1>{`disconnect ${name}`}</h1></header>
        <div className="webapp-confirmation-body">
          <p>
            Disconnecting here revokes this workspace's lease immediately. Your
            account keeps the authorization, so other workspaces keep working and
            you can reconnect this one in a click.
          </p>
        </div>
        <footer className="webapp-confirmation-actions">
          <button className="webapp-action" type="button" onClick={onCancel}>cancel</button>
          <a className="webapp-action" href={settingsPath('connections')}>disconnect everywhere</a>
          <button
            className="webapp-action webapp-confirmation-confirm"
            type="button"
            onClick={onWorkspace}
          >disconnect from this workspace</button>
        </footer>
      </section>
    </ModalOverlay>
  );
}

/** Every provider this workspace could hold, as one list.
 *
 * It replaces a template section, a provider grid, a detail card below the
 * grid, and a separate lease list — four places that each told part of the
 * truth about one provider, and disagreed about the rest. A row is the whole
 * truth about one provider: whether the workspace holds it, who authorized it
 * and when, and the one surface that changes that.
 */
export function WorkspaceProviderRows({
  client,
  workspaceId,
  stipulated,
  leases,
  now,
  focusProvider,
  focusVersion,
  readOnly,
  revoking,
  onRevokeLease,
  onLeaseMinted,
  onConnected,
}: {
  client: ProviderRowsClient;
  workspaceId: string;
  /** Connection names the workspace ceiling enables. Listed first, badged. */
  stipulated: readonly string[];
  /** One lease per connection: the live one where there is one. */
  leases: readonly CredentialLeaseView[];
  now: number;
  focusProvider: string | null;
  /** Bumped per `blitz connections open`, so the same provider re-expands. */
  focusVersion: number;
  readOnly?: boolean;
  revoking: string | null;
  onRevokeLease: (lease: CredentialLeaseView) => Promise<void>;
  onLeaseMinted: (lease: CredentialLeaseView) => void;
  /** A provider just became live here: the panel resolves any matching
   * connect request and pushes the credential at the box. */
  onConnected: (connectionName: string) => void;
}) {
  const [catalog, setCatalog] = useState<CatalogEntryView[]>([]);
  const [grants, setGrants] = useState<UserGrantView[]>([]);
  const [orgConnections, setOrgConnections] = useState<ConnectionView[]>([]);
  const [grantsVersion, setGrantsVersion] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [formVersion, setFormVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<ProviderRow | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    void client.listConnectionCatalog(abort.signal).then(
      (response) => setCatalog(response.providers),
      (caught) => {
        if (abort.signal.aborted) return;
        setError(caughtErrorMessage(caught, 'Provider catalog failed to load.'));
      },
    );
    return () => abort.abort();
  }, [client]);

  // Refetched whenever a row opens, not only on mount: a person who authorized
  // a provider in another tab used to find this panel still offering to
  // authorize it, because the grant list was read once and never again.
  useEffect(() => {
    const abort = new AbortController();
    void client.listConnectionGrants(abort.signal).then(
      (response) => setGrants(response.grants),
      () => undefined,
    );
    return () => abort.abort();
  }, [client, grantsVersion]);

  // The org's declared rows carry the instance URL for instance-hosted
  // vendors, so a paste form can prefill it instead of asking.
  useEffect(() => {
    const abort = new AbortController();
    void client.listConnections(abort.signal).then(
      (response) => setOrgConnections(response.connections),
      () => undefined,
    );
    return () => abort.abort();
  }, [client, grantsVersion]);

  const open = useCallback((row: ProviderRow, mode: 'connect' | 'replace') => {
    setExpanded(row.name);
    setReplacing(mode === 'replace' ? row.name : null);
    setName(row.name);
    setFormVersion((current) => current + 1);
    setGrantsVersion((current) => current + 1);
    setError(null);
  }, []);

  const close = () => {
    setExpanded(null);
    setReplacing(null);
  };

  const rows = buildRows(stipulated, catalog, leases, grants);

  // An agent's `blitz connections open <provider>` lands here: the row opens
  // itself. Each focus is a fresh version, so pointing twice at the same
  // provider re-opens a row the person closed.
  useEffect(() => {
    if (focusProvider === null) return;
    setExpanded(focusProvider);
    setReplacing(null);
    setName(focusProvider);
    setFormVersion((current) => current + 1);
    setGrantsVersion((current) => current + 1);
  }, [focusProvider, focusVersion]);

  const connectNow = async (row: ProviderRow) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const { lease } = await client.mintWorkspaceConnection(workspaceId, row.name);
      onLeaseMinted(lease);
      onConnected(row.name);
      close();
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Connect failed.'));
    } finally {
      setSaving(false);
    }
  };

  const submit = async (row: ProviderRow, event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const entry = row.entry;
    if (saving || entry === null) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const provider = String(data.get('name') ?? '').trim() || row.name;
    setSaving(true);
    setError(null);
    try {
      await client.putConnectionGrant(provider, grantInput(entry, data));
      // A key pasted inside a workspace was pasted in order to connect it, so
      // the lease follows the grant without a second click.
      const { lease } = await client.mintWorkspaceConnection(workspaceId, provider);
      onLeaseMinted(lease);
      onConnected(provider);
      form.reset();
      setGrantsVersion((current) => current + 1);
      close();
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Connect failed.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="workspace-drawer-panel workspace-leases"
      aria-label="Workspace providers"
    >
      {error !== null && <p className="webapp-form-message" role="alert">{error}</p>}
      <div className="workspace-credential-rows">
        {rows.map((row) => {
          const connected = isConnected(row, now);
          const backed = isBacked(row, orgConnections);
          const isOpen = expanded === row.name;
          const showForm = replacing === row.name || (!backed && row.entry !== null);
          const oauthHref = row.entry?.oauthConfigured === true
            ? client.connectStartUrl(row.name, workspaceId)
            : null;
          return (
            <article
              className={`workspace-credential-row workspace-provider-row${
                focusProvider === row.name ? ' workspace-credential-row--focus' : ''
              }`}
              key={row.name}
            >
              <div className="workspace-credential-row__title">
                <button
                  className="workspace-provider-row__toggle"
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => (isOpen ? close() : open(row, 'connect'))}
                >
                  <strong>{row.title}</strong>
                </button>
                {row.stipulated && (
                  <span className="workspace-state-badge">from template</span>
                )}
                {connected && (
                  <span className="workspace-state-badge workspace-state-badge--active">
                    Connected
                  </span>
                )}
              </div>
              {(row.grant !== null || row.lease !== null) && (
                <div className="workspace-credential-row__meta">
                  {row.grant !== null && <span>{provenance(row.grant)}</span>}
                  {row.lease !== null && (
                    <span>{CUSTODY_BADGE[row.lease.mode === 'inject' ? 'cp' : 'proxy']}</span>
                  )}
                </div>
              )}
              {readOnly !== true && (
                <div className="workspace-credential-row__actions">
                  {connected ? (
                    <>
                      {row.entry?.personalTokenLabel != null ? (
                        <button
                          className="webapp-action"
                          type="button"
                          onClick={() => open(row, 'replace')}
                        >Replace key</button>
                      ) : oauthHref !== null && (
                        <a className="webapp-action" href={oauthHref}>Reauthorize</a>
                      )}
                      <button
                        className="webapp-action"
                        type="button"
                        disabled={revoking !== null}
                        onClick={() => setDisconnecting(row)}
                      >{revoking === row.lease?.id ? 'Disconnecting…' : 'Disconnect'}</button>
                    </>
                  ) : (
                    // One word, whatever stands behind the provider. With a
                    // credential already there this mints silently and the
                    // chip flips; without one the row opens its connect
                    // surface. The member never has to tell the two apart.
                    <button
                      className="webapp-action webapp-action--primary"
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        if (backed) {
                          void connectNow(row);
                          return;
                        }
                        open(row, 'connect');
                      }}
                    >Connect</button>
                  )}
                </div>
              )}
              {isOpen && readOnly !== true && (
                <div className="workspace-provider-row__surface">
                  {row.entry === null ? (
                    <p className="connect-help">
                      An agent asked for {row.name} by name. It is not in the provider
                      catalog, so there is nothing to authorize here.
                    </p>
                  ) : showForm ? (
                    <ProviderConnectSurface
                      entry={row.entry}
                      connectionName={name}
                      onConnectionNameChange={setName}
                      lockedBaseUrl={lockedInstanceBaseUrl(row.entry, orgConnections)}
                      oauthHref={oauthHref}
                      oauthLabel={`Connect with ${row.title}`}
                      submitLabel="Connect"
                      saving={saving}
                      formKey={`${row.name}:${String(formVersion)}`}
                      onSubmit={(event) => { void submit(row, event); }}
                      onCancel={close}
                    />
                  ) : (
                    <p className="connect-help">
                      {row.title} already has a credential behind it. Connecting
                      takes one click and no form.
                    </p>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {disconnecting !== null && (
        <DisconnectChooser
          name={disconnecting.name}
          onCancel={() => setDisconnecting(null)}
          onWorkspace={() => {
            const lease = disconnecting.lease;
            setDisconnecting(null);
            if (lease !== null) void onRevokeLease(lease);
          }}
        />
      )}
    </section>
  );
}

/** Stipulated providers first, in the order the template named them, then
 * every other provider the catalog offers, then anything this workspace
 * already holds that the catalog does not know about. */
export function buildRows(
  stipulated: readonly string[],
  catalog: readonly CatalogEntryView[],
  leases: readonly CredentialLeaseView[],
  grants: readonly UserGrantView[],
): ProviderRow[] {
  const entryFor = (nameKey: string): CatalogEntryView | null =>
    catalog.find((candidate) => candidate.id === nameKey) ?? null;
  const make = (nameKey: string, isStipulated: boolean): ProviderRow => {
    const entry = entryFor(nameKey);
    return {
      name: nameKey,
      title: entry?.title ?? nameKey,
      entry,
      stipulated: isStipulated,
      lease: leases.find((lease) => lease.connection === nameKey) ?? null,
      grant: grants.find((grant) => grant.provider === nameKey) ?? null,
    };
  };
  const ordered: ProviderRow[] = [];
  const seen = new Set<string>();
  const push = (nameKey: string, isStipulated: boolean) => {
    if (seen.has(nameKey)) return;
    seen.add(nameKey);
    ordered.push(make(nameKey, isStipulated));
  };
  for (const nameKey of stipulated) push(nameKey, true);
  const rest: string[] = [
    ...catalog.map((entry) => entry.id),
    ...leases.map((lease) => lease.connection),
  ].filter((nameKey) => !seen.has(nameKey));
  for (const nameKey of [...new Set(rest)].sort()) push(nameKey, false);
  return ordered;
}
