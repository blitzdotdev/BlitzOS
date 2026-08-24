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
import {
  grantInput,
  lockedInstanceBaseUrl,
  ProviderConnectSurface,
} from './ProviderConnectSurface';
import { ProviderGlyph } from './ProviderGlyph';

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
  /** The connection name: a catalog id, or a name an agent asked for that the
   * catalog does not know. */
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

/** "you signed in Aug 21". The workspace mints from its owner's grants at
 * create time by design, so a member who never touched this panel can find a
 * provider already connected. This line is the only thing on the tile that
 * answers "why is this on when I never touched it", so it prints on a
 * connected tile and nowhere else — beside Connect it reads as a contradiction
 * rather than an explanation. */
function provenance(grant: UserGrantView): string {
  const when = new Date(grant.createdAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `you signed in ${when}`;
}

/** What the tile says, in one word.
 *
 * Three states, and no fourth. `on` means the workspace holds a live lease.
 * `go` means pressing the tile connects it — whether that mints silently from
 * a credential already on file or opens a form is exactly what the press
 * reveals, so the tile does not say. `blocked` means pressing would fail, and
 * clearing it is an admin's job or an operator's. */
interface TileState {
  kind: 'on' | 'go' | 'blocked';
  word: string;
}

function tileState(
  row: ProviderRow,
  connected: boolean,
  backed: boolean,
  memberPath: boolean,
): TileState {
  if (connected) return { kind: 'on', word: 'Connected' };
  // An agent asked for a name the catalog does not know. There is no form to
  // open and nothing to mint.
  if (row.entry === null) return { kind: 'blocked', word: 'Unknown' };
  if (!backed && !memberPath) return { kind: 'blocked', word: 'Needs a key' };
  return { kind: 'go', word: 'Connect' };
}

/** Revoking a lease and revoking a grant are different acts with different
 * blast radii, and the old panel offered only the first while describing the
 * second. Naming both, in one place, is the fix. */
function DisconnectChooser({
  row,
  onWorkspace,
  onCancel,
}: {
  row: ProviderRow;
  onWorkspace: () => void;
  onCancel: () => void;
}) {
  const name = row.name;
  // Inject custody hands the box the credential itself, not a lease token.
  // Revoking the lease unsets our copy; it cannot reach into the vendor and
  // make a Discord bot token stop working. Saying so is the difference between
  // a promise we keep and one the vendor would have to keep for us.
  const injected = row.lease?.mode === 'inject';
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
          {injected && (
            <p>
              This workspace holds the {row.title} credential itself, not a
              lease token. Revoking the lease removes our copy; the credential
              stays installed and valid until you rotate it at {row.title}.
            </p>
          )}
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
    // A grant is always filed under the catalog id; the control plane refuses
    // any other name, and the form's name field is read-only for that reason.
    const provider = row.name;
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
      <div className="wsc-list">
        {rows.map((row) => {
          const connected = isConnected(row, now);
          const backed = isBacked(row, orgConnections);
          const isOpen = expanded === row.name;
          const showForm = replacing === row.name || (!backed && row.entry !== null);
          const oauthHref = row.entry?.oauthConfigured === true
            ? client.connectStartUrl(row.name, workspaceId)
            : null;
          // A path the member can walk without waiting on anyone: a token to
          // paste, or an OAuth round trip this instance actually has a client
          // registered for.
          const memberPath = row.entry !== null
            && (row.entry.personalTokenLabel !== null
              || (row.entry.oauthAvailable && oauthHref !== null));
          const state = tileState(row, connected, backed, memberPath);
          return (
            <article
              className={`wsc-tile wsc-tile--${state.kind}${
                focusProvider === row.name ? ' wsc-tile--focus' : ''
              }`}
              key={row.name}
            >
              {/* The whole tile is the control, the way a template tile is.
                * That is what keeps a trailing button off every row. */}
              <button
                className="wsc-tile__main"
                type="button"
                aria-expanded={isOpen}
                disabled={readOnly === true}
                onClick={() => {
                  if (isOpen) {
                    close();
                    return;
                  }
                  // A credential already stands behind it, so the press is the
                  // whole act: mint, and let the tile flip.
                  if (!connected && backed) {
                    void connectNow(row);
                    return;
                  }
                  open(row, 'connect');
                }}
              >
                <span className="wsc-tile__head">
                  <ProviderGlyph className="wsc-tile__glyph" provider={row.name} />
                  <span className="wsc-tile__name">
                    <strong>{row.title}</strong>
                    {connected && row.grant !== null && <span>{provenance(row.grant)}</span>}
                  </span>
                  {row.stipulated && <em className="wsc-tile__chip">from template</em>}
                </span>
                <span className="wsc-tile__state">{state.word}</span>
              </button>
              {isOpen && readOnly !== true && (
                <div className="wsc-tile__open">
                  {row.entry === null ? (
                    <p className="connect-help">
                      An agent asked for {row.name} by name. It is not in the
                      provider catalog.
                    </p>
                  ) : showForm ? (
                    <ProviderConnectSurface
                      entry={row.entry}
                      connectionName={row.name}
                      lockedBaseUrl={lockedInstanceBaseUrl(row.entry, orgConnections)}
                      oauthHref={oauthHref}
                      oauthLabel={`Connect with ${row.title}`}
                      submitLabel="Connect"
                      saving={saving}
                      formKey={`${row.name}:${String(formVersion)}`}
                      onSubmit={(event) => { void submit(row, event); }}
                      onCancel={close}
                    />
                  ) : connected ? (
                    <>
                      <p className="connect-help">
                        Disconnecting stops this workspace only. Your sign-in stays.
                      </p>
                      <div className="wsc-tile__actions">
                        {row.entry.personalTokenLabel != null ? (
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
                      </div>
                    </>
                  ) : (
                    // Only `blitz connections open` reaches this: pressing the
                    // tile would have minted instead of opening it.
                    <div className="wsc-tile__actions">
                      <button
                        className="webapp-action webapp-action--primary"
                        type="button"
                        disabled={saving}
                        onClick={() => { void connectNow(row); }}
                      >Connect</button>
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {disconnecting !== null && (
        <DisconnectChooser
          row={disconnecting}
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
