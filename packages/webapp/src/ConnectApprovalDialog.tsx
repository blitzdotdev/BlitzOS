import type {
  CatalogEntryView,
  CredentialRequestView,
  UserGrantView,
  WorkspaceMemberView,
} from '@blitzos/schema';
import { useEffect, useRef, useState } from 'react';
import type { ControlPlaneClient } from './api';
import { connectMethod, type ConnectMethodKind } from './connections/connect-method';
import { caughtErrorMessage } from './error-message';
import { ModalOverlay } from './ModalOverlay';
import { settingsPath } from './sessions-page-state';

export type ConnectDialogClient = Pick<
  ControlPlaneClient,
  | 'listConnectionCatalog'
  | 'listConnectionGrants'
  | 'mintWorkspaceConnection'
  | 'connectStartUrl'
>;

/** The workspace the request came from, and whose machine raised it. The wire
 * carries a `boxId`; the name beside it is resolved here the way
 * `proposalOrigin` resolves a proposal's machine. */
export type ConnectDialogWorkspace = {
  id: string;
  name: string;
  members: ReadonlyArray<Pick<WorkspaceMemberView, 'membershipId' | 'name' | 'machine'>>;
};

function machineOwner(
  request: CredentialRequestView,
  workspace: ConnectDialogWorkspace,
): string | null {
  const boxId = request.requester?.boxId ?? null;
  if (boxId === null) return null;
  return workspace.members.find(({ machine }) => machine?.id === boxId)?.name ?? null;
}

/** What the one primary action does, and the one line under it.
 *
 * The dialog has no form and no scope picker: scopes and workspace enablement
 * are the catalog's defaults, and everything else is the connect path settings
 * already offers. So the button is one of four things, and which one is read
 * off what the member already holds and what the provider supports.
 */
type ConnectAction =
  | { kind: 'mint'; help: string }
  | { kind: 'link'; href: string; help: string }
  | { kind: 'blocked'; help: string };

function connectAction(
  client: Pick<ControlPlaneClient, 'connectStartUrl'>,
  workspaceId: string,
  connectionName: string,
  entry: CatalogEntryView | null,
  grant: UserGrantView | null,
): ConnectAction {
  // The member authorized this provider already, so connecting it here is a
  // mint against a credential the control plane holds — no round trip, no
  // form, nothing to type.
  if (grant !== null) return { kind: 'mint', help: 'Already on your account.' };
  if (entry === null) {
    return { kind: 'blocked', help: `${connectionName} is not in the provider catalog.` };
  }
  const kind: ConnectMethodKind = connectMethod(entry).kind;
  if (kind === 'oauth') {
    return {
      kind: 'link',
      href: client.connectStartUrl(connectionName, workspaceId),
      help: `You sign in at ${entry.title}; the agent never sees your password.`,
    };
  }
  if (kind === 'token') {
    // The paste form is an account surface, so this leaves the workspace for
    // the one page that has it rather than growing a second copy in a modal.
    return {
      kind: 'link',
      href: settingsPath('connections'),
      help: `${entry.title} needs a key on your account.`,
    };
  }
  return {
    kind: 'blocked',
    help: kind === 'admin'
      ? `An admin stores one ${entry.title} key for the organization.`
      : `${entry.title} is not configured on this instance.`,
  };
}

/**
 * An agent asked for a connection this workspace does not have, and this is
 * the ask (`GET /credential-requests`, polled by the shell).
 *
 * IT WEARS THE APPROVAL DIALOG'S FRAME (`AccessApprovalDialog`), down to the
 * `ga-` classes: a member meets exactly one "an agent is asking" shape,
 * whether what it wants is a credential's access list or a provider. What
 * differs is that this one has no diff to edit — there is a single provider,
 * and its scopes are the catalog's defaults — so the body is the request card
 * and nothing else.
 *
 * CLOSE IS NEITHER YES NOR NO. Both × and "Not now" dismiss the ask for this
 * session and leave the request pending on the server; nothing is denied. The
 * agent asks again, and the next request is a new id, so the dialog comes back
 * for the next ask rather than for the one that was waved off.
 */
export function ConnectApprovalDialog({
  client,
  request,
  workspace,
  onDismiss,
  onConnected,
}: {
  client: ConnectDialogClient;
  request: CredentialRequestView;
  workspace: ConnectDialogWorkspace;
  /** Wave it off for this session. The request stays pending. */
  onDismiss: () => void;
  /** The workspace may now pull the provider: the host answers the request
   * that asked for it and re-polls. */
  onConnected: (request: CredentialRequestView) => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const [entry, setEntry] = useState<CatalogEntryView | null>(null);
  const [grant, setGrant] = useState<UserGrantView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectionName = request.connection_name;

  useEffect(() => { closeButton.current?.focus(); }, []);
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      client.listConnectionCatalog(abort.signal),
      client.listConnectionGrants(abort.signal),
    ]).then(
      ([catalog, grants]) => {
        if (abort.signal.aborted) return;
        setEntry(catalog.providers.find(({ id }) => id === connectionName) ?? null);
        setGrant(grants.grants.find(({ provider }) => provider === connectionName) ?? null);
      },
      (caught) => {
        // The card still names what asked and for what; only the connect path
        // is unknown, and the button says so by staying out of the way.
        if (!abort.signal.aborted) {
          setError(caughtErrorMessage(caught, 'The provider catalog failed to load.'));
        }
      },
    );
    return () => abort.abort();
  }, [client, connectionName]);

  const title = entry?.title ?? connectionName;
  const action = connectAction(client, workspace.id, connectionName, entry, grant);
  const owner = machineOwner(request, workspace);
  // No `reason` crosses the wire (`CredentialRequestView`), so the quote is
  // the ask itself: the scopes the agent named, or the connection it named
  // when it asked for no scopes at all.
  const ask = request.requested_scopes.length === 0
    ? connectionName
    : request.requested_scopes.join(', ');

  const mint = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.mintWorkspaceConnection(workspace.id, connectionName);
      onConnected(request);
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Connect failed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalOverlay onDismiss={onDismiss} dismissible={!busy}>
      <section
        className="workspace-details-dialog access-approval-dialog connect-approval-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-approval-title"
      >
        <header className="workspace-details-header">
          <h1 id="connect-approval-title">Connect {title}?</h1>
          <button
            ref={closeButton}
            type="button"
            title="Close — decide later"
            aria-label="Close"
            onClick={onDismiss}
          >×</button>
        </header>
        <div className="ga-req">
          <div className="ga-req-from">
            <span className="ga-req-agent" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 7V4M8 12h.01M16 12h.01M9 16h6" /></svg>
            </span>
            <b>Agent</b>
            <span>
              {owner !== null && ` · on ${owner}'s machine`}
              {` · workspace ${workspace.name}`}
            </span>
          </div>
          <p className="ga-req-why">“{ask}”</p>
        </div>
        {error !== null && <p className="workspace-details-error" role="alert">{error}</p>}
        <footer className="workspace-details-footer cfg-footer ga-foot">
          <p className="cfg-help">{action.help}</p>
          <button
            className="webapp-action"
            type="button"
            disabled={busy}
            onClick={onDismiss}
          >Not now</button>
          {action.kind === 'link' ? (
            <a className="webapp-action webapp-action--primary" href={action.href}>
              Connect {title}
            </a>
          ) : (
            <button
              className="webapp-action webapp-action--primary"
              type="button"
              disabled={busy || action.kind === 'blocked'}
              onClick={() => { void mint(); }}
            >Connect {title}</button>
          )}
        </footer>
      </section>
    </ModalOverlay>
  );
}
