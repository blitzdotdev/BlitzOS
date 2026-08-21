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
import { ConnectPicker } from '../src/settings/ConnectPicker.js';
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
    docsUrl: `https://example.com/${id}`,
    custody: 'proxy',
    rotation: 'none',
    oauthAvailable: false,
    oauthConfigured: false,
    personalTokenLabel: 'API key',
    personalTokenHelp: null,
    needsVendorConfig: false,
    environmentNames: [],
    scopes: [],
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

function liveLease(connection: string): CredentialLeaseView {
  return {
    id: `lease-${connection}`,
    workspaceId: 'workspace-one',
    boxId: null,
    connection,
    userId: null,
    scopes: [],
    mode: 'proxy',
    issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 600_000,
    state: 'active',
  };
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

  it('renders leases and revokes only after confirmation', async () => {
    const revokeLease = vi.fn(async () => undefined);
    const lease: CredentialLeaseView = {
      id: 'lease-one',
      workspaceId: 'workspace-one',
      boxId: null,
      connection: 'github',
      userId: null,
      scopes: ['repo:read'],
      mode: 'inject',
      issuedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      state: 'active',
    };
    const wire = client({
      revokeLease,
      listLeases: vi.fn(async () => ({
        leases: [lease],
      })),
    });
    const view = await render(connectionsPanel(wire));
    await settle();
    expect(view.container.textContent).toContain('github');
    expect(view.container.textContent).toContain('repo:read');

    await act(async () => click([...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Revoke')!));
    expect(revokeLease).not.toHaveBeenCalled();
    await act(async () => click([...document.body.querySelectorAll('button')]
      .find((button) => button.textContent === 'Revoke access')!));
    await settle();
    expect(revokeLease).toHaveBeenCalledWith('lease-one');
    expect(view.container.textContent).toContain('revoked');
    // The panel names the transport the way a connect card names custody.
    expect(view.container.textContent).toContain('injected');
    await view.unmount();
  });

  /** Every credential sync used to mint another lease and retire none, so a
   * workspace connected once carried a stack of active rows for it. */
  it('shows one row per connection and revokes the live one', async () => {
    const revokeLease = vi.fn(async () => undefined);
    const base = {
      workspaceId: 'workspace-one',
      boxId: null,
      connection: 'google-workspace',
      userId: null,
      scopes: [],
      mode: 'proxy' as const,
      state: 'active' as const,
    };
    const stale: CredentialLeaseView = {
      ...base,
      id: 'lease-old',
      issuedAt: Date.now() - 600_000,
      expiresAt: Date.now() + 30_000,
    };
    const fresh: CredentialLeaseView = {
      ...base,
      id: 'lease-new',
      issuedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 600_000,
    };
    const wire = client({
      revokeLease,
      listLeases: vi.fn(async () => ({ leases: [fresh, stale] })),
    });
    const view = await render(connectionsPanel(wire));
    await settle();
    expect(view.container.querySelectorAll('.workspace-credential-row').length).toBe(1);
    expect(view.container.textContent).toContain('proxied');

    await act(async () => click([...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Revoke')!));
    await act(async () => click([...document.body.querySelectorAll('button')]
      .find((button) => button.textContent === 'Revoke access')!));
    await settle();
    expect(revokeLease).toHaveBeenCalledWith('lease-new');
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

  /** Settings is account scope: nothing is connected there, because there is no
   * workspace to hold a lease. A grant is an authorization, and says so. */
  it('marks an authorized provider on the settings page and offers to replace it', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear, notion] })),
      listConnectionGrants: vi.fn(async () => ({ grants: [accountGrant('linear')] })),
    });
    const view = await render(<ConnectPicker client={wire} />);
    await settle();

    const cards = [...view.container.querySelectorAll('.connect-card')];
    const authorized = cards.find((card) => card.textContent?.includes('Linear'))!;
    const untouched = cards.find((card) => card.textContent?.includes('Notion'))!;
    expect(authorized.querySelector('.connect-badge--authorized')?.textContent).toBe('Authorized');
    expect(untouched.querySelector('.connect-badge--authorized')).toBeNull();
    // The word "Connected" belongs to a workspace holding a lease, and this
    // page has no workspace.
    expect(view.container.querySelector('.connect-badge--connected')).toBeNull();
    expect(view.container.textContent).not.toContain('Connected');

    await act(async () => click(authorized));
    expect(view.container.querySelector('.connect-detail__authorized')?.textContent)
      .toBe('Authorized · oauth');
    const labels = [...view.container.querySelectorAll('.connect-detail button, .connect-detail a')]
      .map((action) => action.textContent);
    expect(labels).toContain('Replace key');
    expect(labels).not.toContain('Reconnect');
    await view.unmount();
  });

  it('leaves an unauthorized provider saying Authorize', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear] })),
    });
    const view = await render(<ConnectPicker client={wire} />);
    await settle();
    await act(async () => click(view.container.querySelector('.connect-card')!));
    expect(view.container.querySelector('.connect-detail__authorized')).toBeNull();
    expect([...view.container.querySelectorAll('.connect-detail button')]
      .map((action) => action.textContent)).toContain('Authorize');
    await view.unmount();
  });

  /** A workspace holding nothing is a page with a connect grid on it. Every
   * other section is a heading over an apology, so none of them are drawn. */
  it('draws no section for leases or activity a new workspace does not have', async () => {
    const view = await render(connectionsPanel(client()));
    await settle();
    expect([...view.container.querySelectorAll('.workspace-sect')]
      .map((heading) => heading.textContent)).toEqual([]);
    expect(view.container.textContent).not.toContain('Nothing is connected in this workspace yet.');
    expect(view.container.textContent).not.toContain('No credential events for this workspace.');
    // The connect grid is the whole panel, and it still stands.
    expect(view.container.querySelector('.connect-picker')).not.toBeNull();
    await view.unmount();
  });

  /** Both sections come back the moment there is something to put in them. */
  it('draws both sections once the workspace holds a lease and an event', async () => {
    const wire = client({
      listLeases: vi.fn(async () => ({ leases: [liveLease('github')] })),
      listCredentialEvents: vi.fn(async () => ({
        events: [{
          id: 1,
          leaseId: 'lease-github',
          event: 'minted' as const,
          detail: null,
          createdAt: Date.now(),
        }],
      })),
    });
    const view = await render(connectionsPanel(wire));
    await settle();
    expect([...view.container.querySelectorAll('.workspace-sect')]
      .map((heading) => heading.textContent)).toEqual(['Connections', 'Recent activity']);
    expect(view.container.textContent).toContain('minted');
    await view.unmount();
  });

  /** The live repro: a brand-new workspace wore a green Connected badge for
   * every provider the account had ever authorized. Connected means this
   * workspace holds a live lease, and nothing else means it. */
  it('shows a grant with no lease here as an unconnected card', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear, notion] })),
      listConnectionGrants: vi.fn(async () => ({
        grants: [accountGrant('linear'), accountGrant('notion')],
      })),
      listLeases: vi.fn(async () => ({ leases: [liveLease('notion')] })),
    });
    const view = await render(connectionsPanel(wire));
    await settle();

    const cards = [...view.container.querySelectorAll('.connect-card')];
    const granted = cards.find((card) => card.textContent?.includes('Linear'))!;
    const leased = cards.find((card) => card.textContent?.includes('Notion'))!;
    // Authorized but not connected here: exactly as bare as a card for a
    // provider the account has never touched.
    expect(granted.querySelector('.connect-badge--connected')).toBeNull();
    expect(granted.querySelector('.connect-badge--authorized')).toBeNull();
    expect(granted.classList.contains('connect-card--connected')).toBe(false);
    expect(leased.querySelector('.connect-badge--connected')?.textContent).toBe('Connected');
    expect(leased.classList.contains('connect-card--connected')).toBe(true);
    await view.unmount();
  });

  /** The grant is plumbing whose only job is making this one click instant. */
  it('connects an authorized provider here in one call and no auth form', async () => {
    const mintWorkspaceConnection = vi.fn(async () => ({ lease: liveLease('linear') }));
    const wire = client({
      mintWorkspaceConnection,
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear] })),
      listConnectionGrants: vi.fn(async () => ({ grants: [accountGrant('linear')] })),
    });
    const view = await render(connectionsPanel(wire));
    await settle();
    await act(async () => click(view.container.querySelector('.connect-card')!));
    // No token field, no OAuth trip: the account already authorized this.
    expect(view.container.querySelector('.connect-form')).toBeNull();
    expect(view.container.querySelector('.connect-detail__authorized')?.textContent)
      .toBe('Authorized · oauth');
    expect([...view.container.querySelectorAll('.connect-detail button')]
      .map((action) => action.textContent)).toEqual(['Cancel', 'Connect']);

    await act(async () => click([...view.container.querySelectorAll('.connect-detail button')]
      .find((button) => button.textContent === 'Connect')!));
    await settle();
    expect(mintWorkspaceConnection).toHaveBeenCalledWith('workspace-one', 'linear');
    // The minted lease lands before the next poll, so the card is green now.
    expect(view.container.querySelector('.connect-card--connected')).not.toBeNull();
    expect(view.container.querySelectorAll('.workspace-credential-row').length).toBe(1);
    await view.unmount();
  });

  /** Connected is the end of the errand, so the pane stops asking for things
   * and says where disconnecting lives. */
  it('sends a connected provider to the Connections list to disconnect', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({ providers: [linear] })),
      listConnectionGrants: vi.fn(async () => ({ grants: [accountGrant('linear')] })),
      listLeases: vi.fn(async () => ({ leases: [liveLease('linear')] })),
    });
    const view = await render(connectionsPanel(wire));
    await settle();
    await act(async () => click(view.container.querySelector('.connect-card')!));
    expect(view.container.querySelector('.connect-detail__connected')?.textContent)
      .toBe('Connected in this workspace · revoke it in Connections below to disconnect.');
    expect(view.container.querySelector('.connect-form')).toBeNull();
    // Nothing left to ask for; the only action is putting the card away.
    expect([...view.container.querySelectorAll('.connect-detail button')]
      .map((action) => action.textContent)).toEqual(['Close']);
    await view.unmount();
  });

  /** An OAuth round trip started here comes back here, with the lease minted. */
  it('carries the workspace into the OAuth round trip', async () => {
    const oauth = { ...linear, oauthAvailable: true, oauthConfigured: true };
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({ providers: [oauth] })),
      connectStartUrl: (provider: string, workspaceId?: string) => (
        `/connect/${provider}/start${workspaceId === undefined ? '' : `?workspaceId=${workspaceId}`}`
      ),
    });
    const view = await render(connectionsPanel(wire));
    await settle();
    await act(async () => click(view.container.querySelector('.connect-card')!));
    const cta = view.container.querySelector('.connect-cta');
    expect(cta?.textContent).toBe('Connect with Linear');
    expect(cta?.getAttribute('href')).toBe('/connect/linear/start?workspaceId=workspace-one');
    await view.unmount();
  });
});
