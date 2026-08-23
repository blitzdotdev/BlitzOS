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
    listLeases: vi.fn(async () => ({ leases: [] })),
    listCredentialEvents: vi.fn(async () => ({ events: [] })),
    mintWorkspaceConnection: vi.fn(async () => { throw new Error('unused'); }),
    revokeLease: vi.fn(async () => undefined),
    listCredentialRequests: vi.fn(async () => ({ requests: [] })),
    approveCredentialRequest: vi.fn(async () => undefined),
    denyCredentialRequest: vi.fn(async () => undefined),
    listConnectionCatalog: vi.fn(async () => ({ providers: [] })),
    listConnectionGrants: vi.fn(async () => ({ grants: [] })),
    listGithubRepositories: vi.fn(async () => ({ repositories: [] })),
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

/** A live lease the box has already fetched: it carries the box id the box's
 * own mint wrote. */
function liveLease(connection: string): CredentialLeaseView {
  return {
    id: `lease-${connection}`,
    workspaceId: 'workspace-one',
    boxId: 'box-one',
    connection,
    userId: null,
    scopes: [],
    mode: 'proxy',
    issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 600_000,
    state: 'active',
  };
}

/** Minted by the webApp, so it carries no box id yet. The panel reads it as
 * connected all the same: whether the box has fetched it is our plumbing, and
 * naming it cost the member a word they could do nothing with. */
function undeliveredLease(connection: string): CredentialLeaseView {
  return { ...liveLease(connection), boxId: null };
}

function rowFor(container: ParentNode, title: string): Element {
  const row = [...container.querySelectorAll('.workspace-provider-row')]
    .find((candidate) => candidate.querySelector('strong')?.textContent === title);
  if (row === undefined) throw new Error(`no provider row for ${title}`);
  return row;
}

function buttonIn(scope: ParentNode, label: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll('button')]
    .find((candidate) => candidate.textContent === label);
  if (button === undefined) throw new Error(`no ${label} button`);
  return button;
}

/** The connections panel as the drawer hosts it, with nothing pending. */
function connectionsPanel(wire: ControlPlaneClient) {
  return (
    <WorkspaceConnectionsPanel
      client={wire}
      workspaceId="workspace-one"
      visible
      pendingRequests={[]}
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
        visible
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
  it('lists stipulated providers first, badged, and never draws the old grid', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({ providers: [notion, linear] })),
    });
    const view = await render(
      <WorkspaceConnectionsPanel
        client={wire}
        workspaceId="workspace-one"
        visible
        pendingRequests={[]}
        stipulatedConnections={['linear']}
        onResolveRequest={async () => undefined}
      />,
    );
    await settle();
    const titles = [...view.container.querySelectorAll('.workspace-provider-row strong')]
      .map((title) => title.textContent);
    expect(titles).toEqual(['Linear', 'Notion']);
    expect(rowFor(view.container, 'Linear').textContent).toContain('from template');
    expect(rowFor(view.container, 'Notion').textContent).not.toContain('from template');
    // The grid and the section heading it sat under are both gone.
    expect(view.container.querySelector('.connect-grid')).toBeNull();
    expect(view.container.textContent).not.toContain('From the template');
    await view.unmount();
  });

  /** Two states, and no third. A live lease is Connected whether or not the
   * box has fetched it yet; everything else is a row with a Connect button. */
  it('reads every live lease as Connected and everything else as Connect', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear, notion] })),
      listLeases: vi.fn(async () => ({ leases: [liveLease('linear')] })),
    });
    const view = await render(connectionsPanel(wire));
    await settle();
    expect(rowFor(view.container, 'Linear').textContent).toContain('Connected');
    const notionRow = rowFor(view.container, 'Notion');
    expect(notionRow.querySelector('.workspace-state-badge')).toBeNull();
    expect(buttonIn(notionRow, 'Connect')).not.toBeNull();
    // The four shades of not-connected the panel used to print are gone.
    for (const gone of ['delivering', 'not here yet', 'needs a key', 'needs you']) {
      expect(view.container.textContent).not.toContain(gone);
    }
    await view.unmount();
  });

  /** A lease the webApp minted carries no box id. It is still live, so it is
   * still Connected: the delivery hop is ours to run, not the member's. */
  it('reads a lease the box has not fetched yet as Connected', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({ providers: [notion] })),
      listLeases: vi.fn(async () => ({ leases: [undeliveredLease('notion')] })),
    });
    const view = await render(connectionsPanel(wire));
    await settle();
    expect(rowFor(view.container, 'Notion').textContent).toContain('Connected');
    await view.unmount();
  });

  it('names who authorized a provider and when', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear] })),
      listConnectionGrants: vi.fn(async () => ({ grants: [accountGrant('linear')] })),
      listLeases: vi.fn(async () => ({ leases: [liveLease('linear')] })),
    });
    const view = await render(connectionsPanel(wire));
    await settle();
    // Create-time minting from an existing owner grant is designed behaviour;
    // provenance is what keeps it from reading as a surprise.
    expect(rowFor(view.container, 'Linear').textContent).toContain('authorized by you ·');
    await view.unmount();
  });

  it('expands inline on Connect and pastes a key without leaving the row', async () => {
    const putConnectionGrant = vi.fn(async () => undefined);
    const mintWorkspaceConnection = vi.fn(async () => ({ lease: undeliveredLease('linear') }));
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

    await act(async () => click(buttonIn(row, 'Connect')));
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
    const mintWorkspaceConnection = vi.fn(async () => ({ lease: undeliveredLease('linear') }));
    const wire = client({
      mintWorkspaceConnection,
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear] })),
      listConnectionGrants: vi.fn(async () => ({ grants: [accountGrant('linear')] })),
    });
    const view = await render(connectionsPanel(wire));
    await settle();
    const row = rowFor(view.container, 'Linear');
    expect(row.textContent).not.toContain('Connected');
    await act(async () => click(buttonIn(row, 'Connect')));
    await settle();
    expect(mintWorkspaceConnection).toHaveBeenCalledWith('workspace-one', 'linear');
    expect(view.container.querySelector('.connect-form')).toBeNull();
    // The mint is silent: the chip flips, and no label reports the hop.
    expect(rowFor(view.container, 'Linear').textContent).toContain('Connected');
    await view.unmount();
  });

  /** An admin's org credential backs the provider for every member, so Connect
   * mints for them too. The row must not ask for a key nobody has to paste. */
  it('connects on an org credential with no grant and no form', async () => {
    const mintWorkspaceConnection = vi.fn(async () => ({ lease: undeliveredLease('linear') }));
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
    await act(async () => click(buttonIn(rowFor(view.container, 'Linear'), 'Connect')));
    await settle();
    expect(mintWorkspaceConnection).toHaveBeenCalledWith('workspace-one', 'linear');
    expect(view.container.querySelector('.connect-form')).toBeNull();
    expect(rowFor(view.container, 'Linear').textContent).toContain('Connected');
    await view.unmount();
  });

  it('offers a connected row Replace key and a Disconnect that names both meanings', async () => {
    const revokeLease = vi.fn(async () => undefined);
    const wire = client({
      revokeLease,
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear] })),
      listConnectionGrants: vi.fn(async () => ({ grants: [accountGrant('linear')] })),
      listLeases: vi.fn(async () => ({ leases: [liveLease('linear')] })),
    });
    const view = await render(connectionsPanel(wire));
    await settle();
    const row = rowFor(view.container, 'Linear');
    expect([...row.querySelectorAll('.workspace-credential-row__actions button')]
      .map((action) => action.textContent)).toEqual(['Replace key', 'Disconnect']);

    // Replace key opens the provider's own key input, inline, on the row.
    await act(async () => click(buttonIn(row, 'Replace key')));
    expect(rowFor(view.container, 'Linear').querySelector('input[name="token"]')).not.toBeNull();

    await act(async () => click(buttonIn(rowFor(view.container, 'Linear'), 'Disconnect')));
    const dialog = document.body.querySelector('[role="dialog"]');
    if (dialog === null) throw new Error('disconnect chooser is missing');
    // The lease-versus-grant conflation the old panel shipped: one action, two
    // meanings, and only the narrow one was reachable.
    expect(dialog.querySelector('a')?.getAttribute('href')).toBe('/settings/connections');
    expect(dialog.textContent).toContain('disconnect everywhere');
    await act(async () => click(buttonIn(dialog, 'disconnect from this workspace')));
    await settle();
    expect(revokeLease).toHaveBeenCalledWith('lease-linear');
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
    await act(async () => click(buttonIn(rowFor(view.container, 'Linear'), 'Connect')));
    await settle();
    // A grant authorized in another tab used to leave this panel offering to
    // authorize it all over again.
    expect(listConnectionGrants.mock.calls.length).toBeGreaterThan(before);
    await view.unmount();
  });

  it('pushes the credential at the box after a connect', async () => {
    const calls: string[] = [];
    const stubFetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('{"synced":true}', { status: 200 });
    });
    vi.stubGlobal('fetch', stubFetch);
    const wire = client({
      mintWorkspaceConnection: vi.fn(async () => ({ lease: undeliveredLease('linear') })),
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear] })),
      listConnectionGrants: vi.fn(async () => ({ grants: [accountGrant('linear')] })),
    });
    const view = await render(
      <WorkspaceConnectionsPanel
        client={wire}
        workspaceId="workspace-one"
        visible
        pendingRequests={[]}
        filesBase="https://cp.example/workspaces/workspace-one/webapp/7445/workspace/"
        onResolveRequest={async () => undefined}
      />,
    );
    await settle();
    await act(async () => click(buttonIn(rowFor(view.container, 'Linear'), 'Connect')));
    await settle();
    // Boxes pull credentials on a throttled cadence, so without this push the
    // member watches a connected provider stay dark for the whole window.
    expect(calls).toContain(
      'https://cp.example/workspaces/workspace-one/webapp/7445/credentials/sync',
    );
    vi.unstubAllGlobals();
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
          visible
          pendingRequests={[]}
          stipulatedConnections={['linear']}
          connectionsFocus={{ provider: 'linear', at }}
          onResolveRequest={async () => undefined}
        />
      );
    }
    const view = await render(<Harness at={1} />);
    await settle();
    // The agent's `blitz connections open linear` landed: the row is
    // highlighted and its connect surface is already open.
    expect(view.container.querySelector('.workspace-credential-row--focus')?.textContent)
      .toContain('Linear');
    expect(view.container.querySelector('input[name="token"]')).not.toBeNull();

    await act(async () => click(buttonIn(view.container, 'Cancel')));
    expect(view.container.querySelector('input[name="token"]')).toBeNull();
    await act(async () => view.root.render(<Harness at={2} />));
    await settle();
    expect(view.container.querySelector('input[name="token"]')).not.toBeNull();
    await view.unmount();
  });

  it('keeps Wanted here and Recent activity beside the rows', async () => {
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
        visible
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
      .toEqual(['Wanted here', 'Connections', 'Recent activity']);
    await view.unmount();
  });

  it('gives a viewer rows to read and nothing to press', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear] })),
      listLeases: vi.fn(async () => ({ leases: [liveLease('linear')] })),
    });
    const view = await render(
      <WorkspaceConnectionsPanel
        client={wire}
        workspaceId="workspace-one"
        visible
        readOnly
        pendingRequests={[]}
        onResolveRequest={async () => undefined}
      />,
    );
    await settle();
    expect(rowFor(view.container, 'Linear').textContent).toContain('Connected');
    expect(view.container.querySelector('.workspace-credential-row__actions')).toBeNull();
    await view.unmount();
  });
});
