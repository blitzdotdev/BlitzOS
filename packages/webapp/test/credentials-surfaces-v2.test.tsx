import type {
  CatalogEntryView,
  CredentialLeaseView,
  CredentialRequestView,
  UserGrantView,
} from '@blitzos/schema';
import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneClient } from '../src/api.js';
import type { WorkspaceDrawerSegment } from '../src/storage.js';
import {
  WorkspaceConnectionsPanel,
  WorkspaceDrawer,
} from '../src/WorkspaceDrawer.js';
import { buildRows } from '../src/connections/WorkspaceProviderRows.js';
import { WorkspaceRailStrip } from '../src/WorkspaceRailStrip.js';
import { MembersPanel } from '../src/settings/MembersPanel.js';
import { render, settle } from './dom.js';

function client(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  return {
    googleLoginUrl: () => '/auth/google/start',
    inviteGoogleLoginUrl: (code) => `/auth/google/start?invite=${code}`,
    inviteStatus: vi.fn(async () => { throw new Error('unused'); }),
    switchOrg: vi.fn(async () => undefined),
    listMembers: vi.fn(async () => ({ members: [] })),
    updateMember: vi.fn(async () => { throw new Error('unused'); }),
    listInvites: vi.fn(async () => ({ invites: [], ttlDays: 7 })),
    createInvite: vi.fn(async () => { throw new Error('unused'); }),
    revokeInvite: vi.fn(async () => undefined),
    listWorkspaceGrants: vi.fn(async () => ({ grants: [] })),
    createWorkspaceGrant: vi.fn(async () => { throw new Error('unused'); }),
    revokeWorkspaceGrant: vi.fn(async () => undefined),
    listFolders: vi.fn(async () => ({ folders: [] })),
    createFolder: vi.fn(async () => { throw new Error('unused'); }),
    deleteFolder: vi.fn(async () => undefined),
    createFolderGrant: vi.fn(async () => { throw new Error('unused'); }),
    revokeFolderGrant: vi.fn(async () => undefined),
    listFolderObjects: vi.fn(async () => ({ objects: [], cursor: null, truncated: false })),
    downloadFolderObject: vi.fn(async () => new Blob()),
    uploadFolderObject: vi.fn(async () => undefined),
    listWorkspaceFolders: vi.fn(async () => ({ folders: [] })),
    attachFolder: vi.fn(async () => { throw new Error('unused'); }),
    detachFolder: vi.fn(async () => undefined),
    renameFolder: vi.fn(async () => undefined),
    setFolderOrgRole: vi.fn(async () => undefined),
    listAgentRules: vi.fn(async () => ({ rules: [] })),
    putAgentRule: vi.fn(async () => { throw new Error('unused'); }),
    deleteAgentRule: vi.fn(async () => undefined),
    listWorkspaceTemplates: vi.fn(async () => ({ templates: [] })),
    createWorkspaceTemplate: vi.fn(async () => { throw new Error('unused'); }),
    updateWorkspaceTemplate: vi.fn(async () => { throw new Error('unused'); }),
    deleteWorkspaceTemplate: vi.fn(async () => undefined),
    listRecipes: vi.fn(async () => ({ recipes: [] })),
    getRecipe: vi.fn(async () => { throw new Error('unused'); }),
    createRecipe: vi.fn(async () => { throw new Error('unused'); }),
    updateRecipe: vi.fn(async () => { throw new Error('unused'); }),
    deleteRecipe: vi.fn(async () => undefined),
    launchRecipe: vi.fn(async () => { throw new Error('unused'); }),
    getUsageCapture: vi.fn(async () => ({ enabled: false, folderId: null })),
    putUsageCapture: vi.fn(async (enabled: boolean) => ({ enabled, folderId: null })),
    setWorkspaceOrgRole: vi.fn(async () => undefined),
    deleteFolderObject: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    me: vi.fn(async () => { throw new Error('unused'); }),
    createOrg: vi.fn(async () => { throw new Error('unused'); }),
    getGlobalWebAppState: vi.fn(async () => ({ doc: null, updatedAt: null })),
    putGlobalWebAppState: vi.fn(async (doc) => ({ doc, updatedAt: 1 })),
    getWorkspaceWebAppState: vi.fn(async () => ({ doc: null, updatedAt: null })),
    putWorkspaceWebAppState: vi.fn(async (_id, doc) => ({ doc, updatedAt: 1 })),
    poll: vi.fn(async () => ({ workspaces: [] })),
    create: vi.fn(async () => { throw new Error('unused'); }),
    destroy: vi.fn(async () => { throw new Error('unused'); }),
    listMachineTypes: vi.fn(async () => ({ machineTypes: [], failures: [] })),
    listVolumes: vi.fn(async () => ({ volumes: [] })),
    listConnections: vi.fn(async () => ({ connections: [] })),
    putConnection: vi.fn(async () => undefined),
    deleteConnection: vi.fn(async () => undefined),
    listCredentialEvents: vi.fn(async () => ({ events: [] })),
    mintWorkspaceConnection: vi.fn(async () => { throw new Error('unused'); }),
    disconnectWorkspaceConnection: vi.fn(async () => undefined),
    listCredentialRequests: vi.fn(async () => ({ requests: [] })),
    approveCredentialRequest: vi.fn(async () => undefined),
    denyCredentialRequest: vi.fn(async () => undefined),
    listConnectionCatalog: vi.fn(async () => ({ providers: [] })),
    listConnectionGrants: vi.fn(async () => ({ grants: [] })),
    listGithubRepositories: vi.fn(async () => ({ repositories: [] })),
    checkGithubRepositories: vi.fn(async (repos: string[]) => ({
      results: repos.map((repo) => ({ repo, reachable: true })),
    })),
    putConnectionGrant: vi.fn(async () => undefined),
    deleteConnectionGrant: vi.fn(async () => undefined),
    listProviderHealth: vi.fn(async () => ({ providers: [] })),
    connectStartUrl: (provider: string) => `/connect/${provider}/start`,
    ...overrides,
  };
}

function click(button: Element): void {
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function catalogEntry(id: string, title: string): CatalogEntryView {
  return {
    id,
    title,
    summary: `${title} for agents`,
    custody: 'proxy',
    oauthAvailable: false,
    oauthConfigured: false,
    personalTokenLabel: 'API key',
    personalTokenHelp: null,
    personalTokenBaseUrlLabel: null,
    adminForm: null,
  };
}

const linear = catalogEntry('linear', 'Linear');
const notion = catalogEntry('notion', 'Notion');

function accountGrant(provider: string): UserGrantView {
  return {
    provider,
    manifestId: provider,
    kind: 'oauth',
    label: null,
    scopes: ['read'],
    createdAt: 1,
    updatedAt: 1,
    accessExpiresAt: null,
  };
}

/** What a mint hands back. The panel ignores it and flips the tile when the
 * call returns. The client type still promises a lease, so a stub supplies
 * one. */
function mintedLease(connection: string): CredentialLeaseView {
  return {
    id: `lease-${connection}`,
    workspaceId: 'workspace-one',
    boxId: null,
    connection,
    userId: null,
    scopes: [],
    mode: 'proxy',
    issuedAt: 1,
    expiresAt: 2_000,
    state: 'active',
  };
}

function rowFor(container: ParentNode, title: string): Element {
  const row = [...container.querySelectorAll('.wsc-tile')]
    .find((candidate) => candidate.querySelector('strong')?.textContent === title);
  if (row === undefined) throw new Error(`no provider tile for ${title}`);
  return row;
}

/** The whole tile is the control, so a press is a press on the tile itself. */
function pressTile(row: ParentNode): HTMLButtonElement {
  const main = row.querySelector<HTMLButtonElement>('.wsc-tile__main');
  if (main === null) throw new Error('no tile button');
  return main;
}

/** The one word the tile prints. */
function stateWord(row: ParentNode): string {
  return row.querySelector('.wsc-tile__state')?.textContent ?? '';
}

function buttonIn(scope: ParentNode, label: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll('button')]
    .find((candidate) => candidate.textContent === label);
  if (button === undefined) throw new Error(`no ${label} button`);
  return button;
}

/** The connections panel as the drawer hosts it, with nothing pending and an
 * empty allow-list. */
function connectionsPanel(
  wire: ControlPlaneClient,
  workspaceConnections: readonly string[] = [],
) {
  return (
    <WorkspaceConnectionsPanel
      client={wire}
      workspaceId="workspace-one"
      pendingRequests={[]}
      workspaceConnections={workspaceConnections}
      onResolveRequest={async () => undefined}
    />
  );
}

describe('v2 credential surfaces', () => {
  it('mints an email-pinned invite from the members panel and shows its link once', async () => {
    const createInvite = vi.fn(async () => ({
      invite: {
        id: 'invite-one',
        email: 'person@example.com',
        role: 'member' as const,
        state: 'ready' as const,
        createdAt: 1,
        expiresAt: 2,
        redeemedAt: null,
      },
      code: 'one-time-code',
      ttlDays: 7,
    }));
    const view = await render(<MembersPanel client={client({ createInvite })} admin />);
    await settle();
    const input = view.container.querySelector<HTMLInputElement>('input[type="email"]')!;
    const setInputValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    if (setInputValue === undefined) throw new Error('input value setter is unavailable');
    await act(async () => {
      setInputValue.call(input, 'person@example.com');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      view.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(createInvite).toHaveBeenCalledWith({ email: 'person@example.com', role: 'member' });
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="Member invite link"]')?.value)
      .toBe(`${window.location.origin}/invite/one-time-code`);
    await view.unmount();
  });

  it('switches drawer segments under controlled workspace state', async () => {
    const wire = client();
    function Harness() {
      const [segment, setSegment] = useState<WorkspaceDrawerSegment>('files');
      return (
        <WorkspaceDrawer
          client={wire}
          workspaceId="workspace-one"
          orgName="Example"
          mobile={false}
          open
          width={264}
          segment={segment}
          pendingRequests={[]}
          livePorts={[]}
          previewLinks={[]}
          filesBase={null}
          previewReady={false}
          onOpenPreview={() => undefined}
          onOpenPreviewLink={() => undefined}
          files={<div>File tree</div>}
          onWidthChange={() => undefined}
          onSegmentChange={setSegment}
          onResolveRequest={async () => undefined}
        />
      );
    }

    let view = await render(<Harness />);
    const credentialsTab = [...view.container.querySelectorAll('[role="tab"]')]
      .find((tab) => tab.textContent?.includes('Connections'))!;
    await act(async () => click(credentialsTab));
    expect(credentialsTab.getAttribute('aria-selected')).toBe('true');
    expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
      .toContain('Connections');
    await view.unmount();
  });

  it('reads a pending request as a connect prompt and dismisses it', async () => {
    const request: CredentialRequestView = {
      id: 'request-one',
      workspace_id: 'workspace-one',
      connection_name: 'github',
      requested_scopes: ['repo:read'],
      created_at: Date.now(),
      requester: { boxId: 'box-one', userId: 'user-one' },
    };
    const dismiss = vi.fn(async (_id: string) => undefined);
    function Harness() {
      const [requests, setRequests] = useState([request]);
      return (
        <WorkspaceDrawer
          client={client()}
          workspaceId="workspace-one"
          orgName="Example"
          mobile={false}
          open
          width={264}
          segment="connections"
          pendingRequests={requests}
          livePorts={[]}
          previewLinks={[]}
          filesBase={null}
          previewReady={false}
          onOpenPreview={() => undefined}
          onOpenPreviewLink={() => undefined}
          files={<div>File tree</div>}
          onWidthChange={() => undefined}
          onSegmentChange={() => undefined}
          onResolveRequest={async (entry, action) => {
            if (action === 'deny') await dismiss(entry.id);
            setRequests((current) => current.filter(({ id }) => id !== entry.id));
          }}
        />
      );
    }
    const view = await render(<Harness />);
    await settle();
    expect(view.container.querySelector('.workspace-pending-badge')?.textContent).toBe('1');
    // The inbox states what an agent wanted, not a decision awaiting approval.
    expect(view.container.textContent).toContain('@github');
    expect(view.container.textContent).toContain('An agent asked for');
    expect([...view.container.querySelectorAll('button')].map((button) => button.textContent))
      .not.toContain('Approve');
    await act(async () => click([...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Dismiss')!));
    await settle();
    expect(dismiss).toHaveBeenCalledWith('request-one');
    expect(view.container.querySelector('.workspace-pending-badge')).toBeNull();
    // An empty inbox is a success: the section goes away rather than
    // apologising for having nothing to say.
    expect(view.container.textContent).not.toContain('Wanted here');
    expect(view.container.textContent).not.toContain('No agent has asked for a connection here.');
    await view.unmount();
  });

  it('still speaks when the request list fails to load', async () => {
    const view = await render(
      <WorkspaceConnectionsPanel
        client={client()}
        workspaceId="workspace-one"
        pendingRequests={[]}
        pendingRequestsError="Connect inbox failed to load."
        onResolveRequest={async () => undefined}
      />,
    );
    await settle();
    expect(view.container.textContent).toContain('Wanted here');
    expect(view.container.querySelector('[role="alert"]')?.textContent)
      .toBe('Connect inbox failed to load.');
    await view.unmount();
  });

  /** The panel hides an empty inbox, so the count on the rail icon is the only
   * thing telling a person a request is waiting while the panel is closed. */
  it('keeps the pending count on the rail while the panel is closed', async () => {
    const view = await render(
      <WorkspaceRailStrip
        openPanels={new Set<WorkspaceDrawerSegment>()}
        pendingRequestCount={2}
        onTogglePanel={() => undefined}
      />,
    );
    expect(view.container.querySelector('.workspace-pending-badge')?.textContent).toBe('2');
    await view.unmount();
  });


});


/** Panel v2: one provider row list. It replaced a template section, a provider
 * grid, a detail card under the grid, and a separate lease list — four places
 * that each told part of the truth about one provider. */
describe('workspace provider rows', () => {
  it('lists the allow-list first and never draws the old grid', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({ providers: [notion, linear] })),
    });
    const view = await render(connectionsPanel(wire, ['linear']));
    await settle();
    const titles = [...view.container.querySelectorAll('.wsc-tile strong')]
      .map((title) => title.textContent);
    expect(titles).toEqual(['Linear', 'Notion']);
    // The grid and the heading above it are both gone. So is the chip that
    // named a template. A row now says one thing: may this workspace pull the
    // provider.
    expect(view.container.querySelector('.connect-grid')).toBeNull();
    expect(view.container.textContent).not.toContain('From the template');
    expect(view.container.textContent).not.toContain('from template');
    await view.unmount();
  });

  /** The workspace allow-list is the whole answer. An agent in the box pulls a
   * credential at the moment it asks, so a name on the list is Connected.
   *
   * The panel cannot read a lease to decide it: `ControlPlaneClient` carries no
   * lease reader at all. That is the guarantee, not this test — re-adding a
   * poll means re-adding the method, which a reviewer sees. */
  it('prints Connected for the allow-list, Connect where a member can act, and Needs a key otherwise', async () => {
    const adminOnly: CatalogEntryView = {
      ...catalogEntry('tracker', 'Acme Tracker'),
      personalTokenLabel: null,
    };
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear, notion, adminOnly] })),
    });
    const view = await render(connectionsPanel(wire, ['linear']));
    await settle();
    expect(stateWord(rowFor(view.container, 'Linear'))).toBe('Connected');
    expect(stateWord(rowFor(view.container, 'Notion'))).toBe('Connect');
    expect(stateWord(rowFor(view.container, 'Acme Tracker'))).toBe('Needs a key');
    await view.unmount();
  });

  /** Two names, not one. The panel keeps the allow-list as a joined key so a
   * poll cannot undo an optimistic press, and a key that did not split back
   * left both providers hiding inside one unmatched name. */
  it('prints Connected for every name in a multi-provider allow-list', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear, notion] })),
    });
    const view = await render(connectionsPanel(wire, ['linear', 'notion']));
    await settle();
    expect(stateWord(rowFor(view.container, 'Linear'))).toBe('Connected');
    expect(stateWord(rowFor(view.container, 'Notion'))).toBe('Connected');
    await view.unmount();
  });

  it('names who authorized a provider and when', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear] })),
      listConnectionGrants: vi.fn(async () => ({ grants: [accountGrant('linear')] })),
    });
    const view = await render(connectionsPanel(wire, ['linear']));
    await settle();
    // A template can connect a provider the member never touched; provenance
    // is what keeps that from reading as a surprise.
    expect(rowFor(view.container, 'Linear').textContent).toContain('you signed in');
    await view.unmount();
  });

  it('expands inline on Connect and pastes a key without leaving the row', async () => {
    const putConnectionGrant = vi.fn(async () => undefined);
    const mintWorkspaceConnection = vi.fn(async () => ({ lease: mintedLease('linear') }));
    const wire = client({
      putConnectionGrant,
      mintWorkspaceConnection,
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear] })),
    });
    const view = await render(connectionsPanel(wire));
    await settle();
    const row = rowFor(view.container, 'Linear');
    expect(row.textContent).not.toContain('Connected');
    expect(row.querySelector('.connect-form')).toBeNull();

    await act(async () => click(pressTile(row)));
    const token = rowFor(view.container, 'Linear')
      .querySelector<HTMLInputElement>('input[name="token"]');
    if (token === null) throw new Error('inline key input is missing');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setValue === undefined) throw new Error('input value setter is unavailable');
    await act(async () => {
      setValue.call(token, 'lin_api_test-only');
      token.dispatchEvent(new Event('input', { bubbles: true }));
      rowFor(view.container, 'Linear').querySelector('.connect-form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    // No scope checkboxes anywhere: a pasted key carries the reach its owner
    // gave it, and nothing here can narrow that.
    expect(putConnectionGrant).toHaveBeenCalledWith('linear', {
      manifestId: 'linear',
      token: 'lin_api_test-only',
    });
    expect(mintWorkspaceConnection).toHaveBeenCalledWith('workspace-one', 'linear');
    await view.unmount();
  });

  it('connects an already-authorized provider in one call and no form', async () => {
    const mintWorkspaceConnection = vi.fn(async () => ({ lease: mintedLease('linear') }));
    const wire = client({
      mintWorkspaceConnection,
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear] })),
      listConnectionGrants: vi.fn(async () => ({ grants: [accountGrant('linear')] })),
    });
    const view = await render(connectionsPanel(wire));
    await settle();
    const row = rowFor(view.container, 'Linear');
    expect(row.textContent).not.toContain('Connected');
    await act(async () => click(pressTile(row)));
    await settle();
    expect(mintWorkspaceConnection).toHaveBeenCalledWith('workspace-one', 'linear');
    expect(view.container.querySelector('.connect-form')).toBeNull();
    // The allow-list prop is still empty. The workspace poll behind it trails
    // a press by seconds. The tile flips when the mint returns, so the member
    // never watches a connected provider read Connect.
    expect(stateWord(rowFor(view.container, 'Linear'))).toBe('Connected');
    await view.unmount();
  });

  /** An admin's org credential backs the provider for every member, so Connect
   * mints for them too. The row must not ask for a key nobody has to paste. */
  it('connects on an org credential with no grant and no form', async () => {
    const mintWorkspaceConnection = vi.fn(async () => ({ lease: mintedLease('linear') }));
    const wire = client({
      mintWorkspaceConnection,
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear] })),
      listConnections: vi.fn(async () => ({
        connections: [{
          name: 'linear',
          provider: 'linear',
          kind: 'static' as const,
          custody: 'proxy' as const,
          status: 'active' as const,
          createdBy: 'admin-one',
          proxyBaseUrl: null,
          orgCredential: true,
        }],
      })),
    });
    const view = await render(connectionsPanel(wire));
    await settle();
    await act(async () => click(pressTile(rowFor(view.container, 'Linear'))));
    await settle();
    expect(mintWorkspaceConnection).toHaveBeenCalledWith('workspace-one', 'linear');
    expect(view.container.querySelector('.connect-form')).toBeNull();
    expect(rowFor(view.container, 'Linear').textContent).toContain('Connected');
    await view.unmount();
  });

  it('offers a connected row Replace key and a Disconnect that names both meanings', async () => {
    const disconnectWorkspaceConnection = vi.fn(async () => undefined);
    const deleteConnectionGrant = vi.fn(async () => undefined);
    const wire = client({
      disconnectWorkspaceConnection,
      deleteConnectionGrant,
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear] })),
      listConnectionGrants: vi.fn(async () => ({ grants: [accountGrant('linear')] })),
    });
    const view = await render(connectionsPanel(wire, ['linear']));
    await settle();
    const row = rowFor(view.container, 'Linear');
    // A connected tile rests on one word. Its actions arrive with the press.
    expect(row.querySelector('.wsc-tile__actions')).toBeNull();
    await act(async () => click(pressTile(row)));
    expect([...rowFor(view.container, 'Linear').querySelectorAll('.wsc-tile__actions button')]
      .map((action) => action.textContent)).toEqual(['Replace key', 'Disconnect']);

    // Replace key opens the provider's own key input, inline, on the tile.
    await act(async () => click(buttonIn(rowFor(view.container, 'Linear'), 'Replace key')));
    expect(rowFor(view.container, 'Linear').querySelector('input[name="token"]')).not.toBeNull();

    // Cancel puts the tile back, and the press reopens the two actions.
    await act(async () => click(buttonIn(rowFor(view.container, 'Linear'), 'Cancel')));
    await act(async () => click(pressTile(rowFor(view.container, 'Linear'))));
    await act(async () => click(buttonIn(rowFor(view.container, 'Linear'), 'Disconnect')));
    const dialog = document.body.querySelector('[role="dialog"]');
    if (dialog === null) throw new Error('disconnect chooser is missing');
    // The old panel gave one action two meanings. It reached only the narrow
    // one. The chooser names both and reaches both.
    expect(dialog.querySelector('a')?.getAttribute('href')).toBe('/settings/connections');
    expect(dialog.textContent).toContain('disconnect everywhere');
    await act(async () => click(buttonIn(dialog, 'disconnect from this workspace')));
    await settle();

    // One workspace leaves the allow-list. Nothing else moves: the account
    // authorization stands, so the member's other workspaces keep working.
    expect(disconnectWorkspaceConnection).toHaveBeenCalledWith('workspace-one', 'linear');
    expect(deleteConnectionGrant).not.toHaveBeenCalled();
    expect(stateWord(rowFor(view.container, 'Linear'))).toBe('Connect');
    await view.unmount();
  });

  it('refetches grants every time a row opens', async () => {
    const listConnectionGrants = vi.fn(async () => ({ grants: [] }));
    const wire = client({
      listConnectionGrants,
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear] })),
    });
    const view = await render(connectionsPanel(wire));
    await settle();
    const before = listConnectionGrants.mock.calls.length;
    await act(async () => click(pressTile(rowFor(view.container, 'Linear'))));
    await settle();
    // A grant authorized in another tab used to leave this panel offering to
    // authorize it all over again.
    expect(listConnectionGrants.mock.calls.length).toBeGreaterThan(before);
    await view.unmount();
  });

  it('opens the focused provider row and re-opens it on a fresh focus', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear] })),
    });
    function Harness({ at }: { at: number }) {
      return (
        <WorkspaceConnectionsPanel
          client={wire}
          workspaceId="workspace-one"
          pendingRequests={[]}
          workspaceConnections={[]}
          connectionsFocus={{ provider: 'linear', at }}
          onResolveRequest={async () => undefined}
        />
      );
    }
    const view = await render(<Harness at={1} />);
    await settle();
    // The agent's `blitz connections open linear` landed: the row is
    // highlighted and its connect surface is already open.
    expect(view.container.querySelector('.wsc-tile--focus')?.textContent)
      .toContain('Linear');
    expect(view.container.querySelector('input[name="token"]')).not.toBeNull();

    await act(async () => click(buttonIn(view.container, 'Cancel')));
    expect(view.container.querySelector('input[name="token"]')).toBeNull();
    await act(async () => view.root.render(<Harness at={2} />));
    await settle();
    expect(view.container.querySelector('input[name="token"]')).not.toBeNull();
    await view.unmount();
  });

  it('keeps Wanted here beside the rows and hides Recent activity', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear] })),
      listCredentialEvents: vi.fn(async () => ({
        events: [{
          id: 1,
          leaseId: 'lease-linear',
          event: 'minted' as const,
          detail: null,
          createdAt: Date.now(),
        }],
      })),
    });
    const view = await render(
      <WorkspaceConnectionsPanel
        client={wire}
        workspaceId="workspace-one"
        pendingRequests={[{
          id: 'request-one',
          workspace_id: 'workspace-one',
          connection_name: 'linear',
          requested_scopes: [],
          created_at: Date.now(),
          requester: null,
        }]}
        onResolveRequest={async () => undefined}
      />,
    );
    await settle();
    expect([...view.container.querySelectorAll('.workspace-sect')]
      .map((heading) => heading.textContent))
      .toEqual(['Wanted here', 'Connections']);
    await view.unmount();
  });

  it('gives a viewer rows to read and nothing to press', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear] })),
    });
    const view = await render(
      <WorkspaceConnectionsPanel
        client={wire}
        workspaceId="workspace-one"
        readOnly
        pendingRequests={[]}
        workspaceConnections={['linear']}
        onResolveRequest={async () => undefined}
      />,
    );
    await settle();
    expect(stateWord(rowFor(view.container, 'Linear'))).toBe('Connected');
    expect(view.container.querySelector('.wsc-tile__actions')).toBeNull();
    expect(pressTile(rowFor(view.container, 'Linear')).disabled).toBe(true);
    await view.unmount();
  });
});

describe('buildRows', () => {
  it('puts the allow-list first in its own order and sorts the rest by id', () => {
    const rows = buildRows(['notion', 'linear'], [linear, notion], []);
    expect(rows.map((row) => [row.name, row.connected]))
      .toEqual([['notion', true], ['linear', true]]);

    const mixed = buildRows(['notion'], [linear, notion], []);
    expect(mixed.map((row) => row.name)).toEqual(['notion', 'linear']);
  });

  /** An agent asked for a name the catalog never heard of. The row still
   * prints, because the person needs to see what the agent asked for. */
  it('keeps an allow-list name the catalog does not know', () => {
    const [row] = buildRows(['ghost'], [linear], []);
    expect(row).toMatchObject({ name: 'ghost', title: 'ghost', entry: null, connected: true });
  });
});
