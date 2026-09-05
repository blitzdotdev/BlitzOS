import type { CatalogEntryView, UserGrantView } from '@blitzos/schema';
import { useEffect, useRef, useState } from 'react';
import type { ControlPlaneClient } from './api';
import { useConnectionsFocusTarget } from './connections-focus-target';
import { connectMethod } from './connections/connect-method';
import { ProviderGlyph } from './connections/ProviderGlyph';
import { useConnectedProviders } from './connections/use-connected-providers';
import { buildRows, type ProviderRow } from './connections/WorkspaceProviderRows';
import { caughtErrorMessage } from './error-message';
import { settingsPath } from './sessions-page-state';

export type ConnectionsTabClient = Pick<
  ControlPlaneClient,
  | 'listConnectionCatalog'
  | 'listConnectionGrants'
  | 'mintWorkspaceConnection'
  | 'disconnectWorkspaceConnection'
>;

/** What one row's switch means, and whether the person may throw it.
 *
 * ON is both halves: this workspace's allow-list names the provider AND the
 * member's own grant stands behind it. The allow-list alone used to read as
 * connected for a provider whose credential had just been revoked — a switch
 * that says on for a connection that cannot mint is worse than a tile that
 * says it, because a switch promises the state is the person's to change.
 *
 * A provider the member has not authorized is not theirs to change HERE: the
 * grant is an account fact, and the row sends them to the one page that makes
 * one. A provider with no member path at all (org custody — an admin stores
 * one key for everyone) has no such page, so it reads and does not move.
 */
type RowState = {
  on: boolean;
  /** The member may throw this switch: they hold a grant. */
  toggleable: boolean;
  /** Their own account is what is missing, so Settings is where they go. */
  needsAccount: boolean;
  line: string;
};

function rowState(row: ProviderRow): RowState {
  const grant = row.grant;
  if (grant !== null) {
    return {
      on: row.connected,
      toggleable: true,
      needsAccount: false,
      line: signedIn(grant),
    };
  }
  if (row.entry === null) {
    // An agent asked for a name the catalog does not hold. Nothing can be
    // minted for it and no page can authorize it.
    return { on: false, toggleable: false, needsAccount: false, line: 'Not in the provider catalog' };
  }
  const method = connectMethod(row.entry);
  if (method.kind === 'oauth' || method.kind === 'token') {
    return {
      on: false,
      toggleable: false,
      needsAccount: true,
      line: 'Not connected on your account',
    };
  }
  return {
    on: false,
    toggleable: false,
    needsAccount: false,
    line: method.kind === 'admin' ? 'An admin sets this up' : 'Not configured here',
  };
}

/** "signed in Sep 1": when the member authorized the provider. A template
 * stipulates providers at create time, so a row can be on for a member who
 * never opened this tab, and this is the line that answers why. */
function signedIn(grant: UserGrantView): string {
  return `signed in ${new Date(grant.createdAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })}`;
}

/**
 * The workspace's Connections tab: one list card of toggle rows, one row per
 * provider.
 *
 * IT REPLACED THE TILES. The pane panel said Connected / Connect / Needs a key
 * on a tile that also expanded into a form, so reading a provider and changing
 * it were the same gesture and three different words all meant "press me". A
 * switch says what state a provider is in and what pressing does, and the two
 * things it CANNOT do — authorize an account, configure an org — are a link
 * and a disabled row rather than a fourth word.
 *
 * The switch vocabulary is settings.css's (`.settings-switch-row` and
 * `.settings-switch-track`); `--flush` is what lets one sit in a list card
 * instead of being its own card.
 */
export function WorkspaceConnectionsTab({
  client,
  workspaceId,
  connections,
  readOnly,
  onChanged,
}: {
  client: ConnectionsTabClient;
  workspaceId: string;
  /** Provider names this workspace's allow-list holds, off the workspace poll. */
  connections: readonly string[];
  /** Workspace sharing, not an org role: a viewer reads the rows and throws
   * nothing. */
  readOnly?: boolean;
  /** A settled write; the host runs the workspace poll so the allow-list this
   * tab draws from catches up with what the server holds. */
  onChanged?: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogEntryView[]>([]);
  const [grants, setGrants] = useState<UserGrantView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [connected, noteConnected] = useConnectedProviders(connections);
  // Where the box last pointed. It arrives out of band because the dialog's
  // host carries no per-tab props — see `connections-focus-target.ts`.
  const focus = useConnectionsFocusTarget(workspaceId);
  const focused = useRef<HTMLLabelElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      client.listConnectionCatalog(abort.signal),
      client.listConnectionGrants(abort.signal),
    ]).then(
      ([providers, granted]) => {
        if (abort.signal.aborted) return;
        setCatalog(providers.providers);
        setGrants(granted.grants);
        setLoading(false);
      },
      (caught) => {
        if (abort.signal.aborted) return;
        setError(caughtErrorMessage(caught, 'Providers failed to load.'));
        setLoading(false);
      },
    );
    return () => abort.abort();
  }, [client]);

  const rows = buildRows(connected, catalog, grants);

  // An agent's `blitz connections open <provider>` opened this dialog on this
  // tab; bringing its row into view is what makes the marker land on the
  // provider rather than on the list. A fresh version scrolls again.
  useEffect(() => {
    if (focus === null) return;
    focused.current?.scrollIntoView({ block: 'nearest' });
  }, [focus, loading]);

  const toggle = async (row: ProviderRow, next: boolean) => {
    if (busy !== null) return;
    setBusy(row.name);
    setError(null);
    try {
      if (next) await client.mintWorkspaceConnection(workspaceId, row.name);
      else await client.disconnectWorkspaceConnection(workspaceId, row.name);
      noteConnected(row.name, next);
      onChanged?.();
    } catch (caught) {
      setError(caughtErrorMessage(caught, next ? 'Connect failed.' : 'Disconnect failed.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      id="workspace-details-connections-panel"
      role="tabpanel"
      aria-label="Connections"
      className="workspace-details-connections"
    >
      <div className="cfg-section">
        <div className="cfg-section-head">
          <h2 className="cfg-title">Connections</h2>
        </div>
        {error !== null && <p className="workspace-details-error" role="alert">{error}</p>}
        {loading ? (
          <p className="workspace-details-status" role="status">Loading providers…</p>
        ) : rows.length === 0 ? (
          <p className="workspace-details-status">No providers in the catalog.</p>
        ) : (
          <div className="workspace-connection-rows">
            {rows.map((row) => {
              const state = rowState(row);
              const isFocused = focus?.provider === row.name;
              return (
                <label
                  className={`settings-switch-row settings-switch-row--flush${
                    isFocused ? ' settings-switch-row--focus' : ''
                  }`}
                  key={row.name}
                  ref={isFocused ? focused : null}
                >
                  <ProviderGlyph className="conn-mark" provider={row.name} />
                  <span className="settings-switch-copy">
                    <strong>{row.title}</strong>
                    <span>{state.line}</span>
                  </span>
                  {state.needsAccount && readOnly !== true && (
                    // The grant is an account fact, so the one page that makes
                    // one is where this goes. Nothing here can authorize it.
                    <a className="webapp-action" href={settingsPath('connections')}>Connect</a>
                  )}
                  <input
                    type="checkbox"
                    role="switch"
                    checked={state.on}
                    disabled={!state.toggleable || readOnly === true || busy !== null}
                    aria-label={row.title}
                    onChange={(event) => { void toggle(row, event.currentTarget.checked); }}
                  />
                  <span className="settings-switch-track" aria-hidden="true" />
                </label>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
