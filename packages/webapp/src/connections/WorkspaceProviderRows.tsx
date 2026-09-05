import type {
  CatalogEntryView,
  ConnectionView,
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
  | 'disconnectWorkspaceConnection'
>;

/** One provider, everything this workspace knows about it. Exported because
 * `buildRows` is the ordering two surfaces share: the legacy pane panel's
 * tiles and the workspace-details Connections tab's toggle rows. */
export type ProviderRow = {
  /** The connection name: a catalog id, or a name an agent asked for that the
   * catalog does not know. */
  name: string;
  title: string;
  entry: CatalogEntryView | null;
  /** The workspace's allow-list names it, so an agent in the box may pull it. */
  connected: boolean;
  grant: UserGrantView | null;
};

/** A credential already stands behind this provider, so Connect is a mint and
 * not a form: this member authorized it on their own account. Nothing else
 * backs a connection — an org-shared static is an org credential, not a
 * connection, and never makes a provider row read as connected. */
function isBacked(row: ProviderRow): boolean {
  return row.grant !== null;
}

/** "you signed in Aug 21". A template stipulates providers at create time, so a
 * member who never touched this panel can find a provider already connected.
 * This line is the only thing on the tile that answers "why is this on when I
 * never touched it", so it prints on a connected tile and nowhere else —
 * beside Connect it reads as a contradiction rather than an explanation. */
function provenance(grant: UserGrantView): string {
  const when = new Date(grant.createdAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `you signed in ${when}`;
}

/** What the tile says, in one word.
 *
 * Three states, and no fourth. `on` means this workspace's allow-list names the
 * provider, so an agent in the box can pull it. `go` means pressing the tile
 * connects it — whether that mints silently from a credential already on file
 * or opens a form is exactly what the press reveals, so the tile does not say.
 * `blocked` means pressing would fail, and clearing it is an admin's job or an
 * operator's. */
interface TileState {
  kind: 'on' | 'go' | 'blocked';
  word: string;
}

function tileState(
  row: ProviderRow,
  backed: boolean,
  memberPath: boolean,
): TileState {
  // Both halves, or the word is a lie. `row.connected` is the allow-list
  // alone, so on its own it said Connected for a provider whose credential
  // had just been revoked — while the body of the same tile offered to
  // connect it. Falling through to the rules below yields Connect, which was
  // already the right word for that state.
  if (row.connected && backed) return { kind: 'on', word: 'Connected' };
  // An agent asked for a name the catalog does not know. There is no form to
  // open and nothing to mint.
  if (row.entry === null) return { kind: 'blocked', word: 'Unknown' };
  if (!backed && !memberPath) return { kind: 'blocked', word: 'Needs a key' };
  return { kind: 'go', word: 'Connect' };
}

/** Every provider this workspace could hold, as one list.
 *
 * It replaces a template section, a provider grid, a detail card below the
 * grid, and a separate lease list — four places that each told part of the
 * truth about one provider, and disagreed about the rest. A row is the whole
 * truth about one provider: whether this workspace may pull it, who authorized
 * it and when, and the one surface that changes that.
 */
export function WorkspaceProviderRows({
  client,
  workspaceId,
  connected,
  focusProvider,
  focusVersion,
  readOnly,
  onConnected,
  onDisconnected,
}: {
  client: ProviderRowsClient;
  workspaceId: string;
  /** Provider names this workspace's allow-list holds. Listed first. */
  connected: readonly string[];
  focusProvider: string | null;
  /** Bumped per `blitz connections open`, so the same provider re-expands. */
  focusVersion: number;
  readOnly?: boolean;
  /** This workspace may now pull the provider. */
  onConnected: (connectionName: string) => void;
  /** This workspace may no longer pull the provider. */
  onDisconnected: (connectionName: string) => void;
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
  const [removing, setRemoving] = useState<string | null>(null);

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

  const rows = buildRows(connected, catalog, grants);

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
      await client.mintWorkspaceConnection(workspaceId, row.name);
      onConnected(row.name);
      close();
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Connect failed.'));
    } finally {
      setSaving(false);
    }
  };

  const disconnectNow = async (row: ProviderRow) => {
    if (removing !== null) return;
    setRemoving(row.name);
    setError(null);
    try {
      await client.disconnectWorkspaceConnection(workspaceId, row.name);
      onDisconnected(row.name);
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Disconnect failed.'));
    } finally {
      setRemoving(null);
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
      // the workspace is connected without a second click.
      await client.mintWorkspaceConnection(workspaceId, provider);
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
          const backed = isBacked(row);
          const isOpen = expanded === row.name;
          const showForm = replacing === row.name || (!backed && row.entry !== null);
          const oauthHref = row.entry?.oauthConfigured === true
            ? client.connectStartUrl(row.name, workspaceId)
            : null;
          // A path the member can walk without waiting on anyone: a token to
          // paste, or an OAuth round trip this instance actually has a client
          // registered for.
          const memberPath = row.entry !== null
            && ((row.entry.personalTokenLabel !== null
              && !(row.entry.personalTokenFallbackOnly && oauthHref !== null))
              || (row.entry.oauthAvailable && oauthHref !== null));
          const state = tileState(row, backed, memberPath);
          return (
            <article
              className={`wsc-tile wsc-tile--${state.kind}${
                focusProvider === row.name ? ' wsc-tile--focus' : ''
              }`}
              key={row.name}
            >
              {/* The tile opens and closes. It does not connect.
                *
                * It used to: a press on a backed row minted straight away, so
                * reading a row and changing it were the same gesture and there
                * was no way to look without acting. Only the buttons inside
                * change state now, and every state is reachable by opening the
                * row rather than by knowing what a press would do. */}
              <button
                className="wsc-tile__main"
                type="button"
                aria-expanded={isOpen}
                disabled={readOnly === true}
                onClick={() => { if (isOpen) close(); else open(row, 'connect'); }}
              >
                <span className="wsc-tile__head">
                  <ProviderGlyph className="wsc-tile__glyph" provider={row.name} />
                  <span className="wsc-tile__name">
                    <strong>{row.title}</strong>
                    {row.connected && row.grant !== null && <span>{provenance(row.grant)}</span>}
                  </span>
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
                  ) : row.connected ? (
                    <>
                      <div className="wsc-tile__actions">
                        {row.entry.personalTokenLabel != null
                          && !(row.entry.personalTokenFallbackOnly && oauthHref !== null) ? (
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
                          disabled={removing !== null}
                          onClick={() => { void disconnectNow(row); }}
                        >{removing === row.name ? 'Disconnecting…' : 'Disconnect'}</button>
                      </div>
                    </>
                  ) : (
                    // The one way to connect a row that is not connected yet.
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
    </section>
  );
}

/** Connected providers first, in the order the allow-list holds them, then
 * every other provider the catalog offers. A name the allow-list holds that the
 * catalog does not know still gets a row: an agent asked for it, and the person
 * needs to see what it asked for. */
export function buildRows(
  connected: readonly string[],
  catalog: readonly CatalogEntryView[],
  grants: readonly UserGrantView[],
): ProviderRow[] {
  const entryFor = (nameKey: string): CatalogEntryView | null =>
    catalog.find((candidate) => candidate.id === nameKey) ?? null;
  const ordered: ProviderRow[] = [];
  const seen = new Set<string>();
  const push = (nameKey: string, isConnected: boolean) => {
    if (seen.has(nameKey)) return;
    seen.add(nameKey);
    const entry = entryFor(nameKey);
    ordered.push({
      name: nameKey,
      title: entry?.title ?? nameKey,
      entry,
      connected: isConnected,
      grant: grants.find((grant) => grant.provider === nameKey) ?? null,
    });
  };
  for (const nameKey of connected) push(nameKey, true);
  for (const entry of [...catalog].sort((a, b) => a.id.localeCompare(b.id))) {
    push(entry.id, false);
  }
  return ordered;
}
