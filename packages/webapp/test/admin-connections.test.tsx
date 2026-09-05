import type {
  CatalogEntryView,
  ConnectionView,
  CredentialLeaseView,
  PutUserGrantRequest,
} from '@blitzos/schema';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneClient } from '../src/api.js';
import { WorkspaceProviderRows } from '../src/connections/WorkspaceProviderRows.js';
import { ConnectionsPanel } from '../src/settings/ConnectionsPanel.js';
import { render, settle } from './dom.js';

function client(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  return {
    getComputeCredential: vi.fn(async () => { throw new Error('unused'); }),
    putComputeCredential: vi.fn(async () => { throw new Error('unused'); }),
    deleteComputeCredential: vi.fn(async () => undefined),
    googleLoginUrl: () => '/auth/google/start',
    inviteGoogleLoginUrl: (code) => `/auth/google/start?invite=${code}`,
    inviteStatus: vi.fn(async () => { throw new Error('unused'); }),
    switchOrg: vi.fn(async () => undefined),
    leaveOrg: vi.fn(async () => undefined),
    listMembers: vi.fn(async () => ({ members: [] })),
    updateMember: vi.fn(async () => { throw new Error('unused'); }),
    listInvites: vi.fn(async () => ({ invites: [], ttlDays: 7 })),
    createInvite: vi.fn(async () => { throw new Error('unused'); }),
    revokeInvite: vi.fn(async () => undefined),
    addWorkspaceMember: vi.fn(async () => { throw new Error('unused'); }),
    provisionMemberMachine: vi.fn(async () => { throw new Error('unused'); }),
    updateWorkspace: vi.fn(async () => { throw new Error('unused'); }),
    listWorkspaceRepos: vi.fn(async () => ({ repos: [] })),
    listSessionShares: vi.fn(async () => ({ granted: [], received: [] })),
    grantSessionShare: vi.fn(async () => { throw new Error("unused"); }),
    revokeSessionShare: vi.fn(async () => undefined),
    addWorkspaceRepo: vi.fn(async () => { throw new Error('unused'); }),
    removeWorkspaceRepo: vi.fn(async () => { throw new Error('unused'); }),
    updateWorkspaceMember: vi.fn(async () => { throw new Error('unused'); }),
    removeWorkspaceMember: vi.fn(async () => undefined),
    provisionMachine: vi.fn(async () => { throw new Error('unused'); }),
    stopMachine: vi.fn(async () => { throw new Error('unused'); }),
    startMachine: vi.fn(async () => { throw new Error('unused'); }),
    recreateMachine: vi.fn(async () => { throw new Error('unused'); }),
    setMachineType: vi.fn(async () => { throw new Error('unused'); }),
    destroyMachine: vi.fn(async () => { throw new Error('unused'); }),
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
    orgUsage: vi.fn(async () => ({ seatsUsed: 1, seatLimit: null, vmsUsed: 0, vmLimit: 10, platformCompute: false })),
    billing: vi.fn(async () => { throw new Error('unused'); }),
    putUsageCapture: vi.fn(async (enabled: boolean) => ({ enabled, folderId: null })),
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
    listCredentialEvents: vi.fn(async () => ({ events: [] })),
    mintWorkspaceConnection: vi.fn(async () => { throw new Error('unused'); }),
    disconnectWorkspaceConnection: vi.fn(async () => undefined),
    listCredentialRequests: vi.fn(async () => ({ requests: [] })),
    approveCredentialRequest: vi.fn(async () => undefined),
    denyCredentialRequest: vi.fn(async () => undefined),
    listOrgCredentials: vi.fn(async () => ({ credentials: [] })),
    putOrgCredential: vi.fn(async () => { throw new Error('unused'); }),
    revokeOrgCredential: vi.fn(async () => undefined),
    replaceOrgCredentialGrants: vi.fn(async () => { throw new Error('unused'); }),
    importOrgCredentials: vi.fn(async () => ({ results: [], linesRead: 0 })),
    listGrantProposals: vi.fn(async () => ({ proposals: [] })),
    resolveGrantProposal: vi.fn(async () => { throw new Error('unused'); }),
    listConnectionCatalog: vi.fn(async () => ({ providers: [] })),
    listConnectionGrants: vi.fn(async () => ({ grants: [] })),
    listGithubInstallations: vi.fn(async () => ({ installations: [] })),
    listGithubRepositories: vi.fn(async () => ({
      source: 'installations' as const,
      repositories: [],
      truncated: false,
    })),
    putConnectionGrant: vi.fn(async () => undefined),
    deleteConnectionGrant: vi.fn(async () => undefined),
    listProviderHealth: vi.fn(async () => ({ providers: [] })),
    checkGithubRepositories: vi.fn(async (repos: string[]) => ({
      results: repos.map((repo) => ({ repo, verdict: 'public' as const })),
    })),
    connectStartUrl: (provider: string) => `/connect/${provider}/start`,
    ...overrides,
  };
}

/** A provider the org admin configures once: no OAuth, no personal token,
 * everything the form needs on `adminForm`. Proxy custody carries the
 * instance-URL field; cp custody carries the secret alone. */
function adminEntry(id: string, title: string, proxy: boolean): CatalogEntryView {
  return {
    id,
    title,
    summary: `${title} for the whole organization`,
    custody: proxy ? 'proxy' : 'cp',
    oauthAvailable: false,
    oauthConfigured: false,
    personalTokenLabel: null,
    personalTokenFallbackOnly: false,
    personalTokenHelp: null,
    personalTokenBaseUrlLabel: null,
    adminForm: {
      rootLabel: proxy ? 'Service token' : 'Bot token',
      rootHelp: 'Create it in the vendor console under a service account.',
      placements: proxy
        ? [
            { kind: 'env', name: 'TRACKER_TOKEN', fill: 'token' },
            { kind: 'env', name: 'TRACKER_BASE_URL', fill: 'proxy-url' },
          ]
        : [{ kind: 'env', name: 'DISCORD_BOT_TOKEN', fill: 'token' }],
    },
  };
}

function grantOnlyEntry(id: string, title: string): CatalogEntryView {
  return { ...adminEntry(id, title, false), adminForm: null, personalTokenLabel: 'API key' };
}

/** The youtrack shape after the "just PAT" ruling: a per-member paste whose
 * form also collects the instance URL, no admin form at all. */
function patEntry(id: string, title: string): CatalogEntryView {
  return {
    ...adminEntry(id, title, true),
    adminForm: null,
    personalTokenLabel: 'Permanent token',
    personalTokenFallbackOnly: false,
    personalTokenBaseUrlLabel: 'Instance URL',
  };
}

const setInputValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value',
)?.set;

function typeInto(input: HTMLInputElement, value: string): void {
  if (setInputValue === undefined) throw new Error('input value setter is unavailable');
  setInputValue.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function click(button: Element): void {
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('settings connections panel', () => {
  it('lists connected providers with re-auth and disconnect, and no admin form', async () => {
    const wire = client({
      listConnectionGrants: vi.fn(async () => ({
        grants: [
          {
            provider: 'linear',
            manifestId: 'linear',
            kind: 'oauth' as const,
            label: null,
            scopes: ['read'],
            createdAt: 1,
            updatedAt: 1,
            accessExpiresAt: null,
          },
          {
            provider: 'youtrack',
            manifestId: 'youtrack',
            kind: 'pat' as const,
            label: null,
            scopes: [],
            createdAt: 1,
            updatedAt: 1,
            accessExpiresAt: null,
          },
        ],
      })),
    });
    const view = await render(<ConnectionsPanel client={wire} />);
    await settle();
    // Two sections and no third: an agent's pending request is not a list
    // here, it is the connect dialog in the workspace that raised it.
    expect([...view.container.querySelectorAll('.cfg-title')].map((h) => h.textContent))
      .toEqual(['Connected · 2', 'Available']);
    // An org-custody admin form is not a connection: those keys are org
    // credentials, and nothing on this page configures one.
    expect(view.container.querySelector('.connect-picker')).toBeNull();
    // The catalog is empty in this case, so there is nothing to paste into.
    expect(view.container.querySelector('.connect-form')).toBeNull();
    // Rotation stays: an OAuth grant re-runs the dance from a plain link; a
    // pasted key has no re-auth here — it is re-pasted from its tile.
    const reauth = [...view.container.querySelectorAll('a')]
      .filter((anchor) => anchor.textContent === 'Re-auth');
    expect(reauth.map((anchor) => anchor.getAttribute('href')))
      .toEqual(['/connect/linear/start']);
    const disconnects = [...view.container.querySelectorAll('button')]
      .filter((button) => button.textContent === 'Disconnect');
    expect(disconnects.length).toBe(2);
    // The chip names which kind of credential stands behind each row.
    expect([...view.container.querySelectorAll('.conn-chip')].map((chip) => chip.textContent))
      .toEqual(['oauth', 'token']);
    await view.unmount();
  });

  /** Every catalog provider the member has not connected, each tile saying how
   * that provider connects — read off the catalog view, never off its name. */
  it('offers the unconnected catalog as tiles that name their connect path', async () => {
    const wire = client({
      listConnectionGrants: vi.fn(async () => ({ grants: [] })),
      listConnectionCatalog: vi.fn(async () => ({
        providers: [
          { ...adminEntry('linear', 'Linear', false), adminForm: null, oauthAvailable: true, oauthConfigured: true },
          patEntry('youtrack', 'YouTrack'),
          adminEntry('discord', 'Discord', false),
        ],
      })),
    });
    const view = await render(<ConnectionsPanel client={wire} />);
    await settle();

    const tiles = [...view.container.querySelectorAll('.connect-card')];
    expect(tiles.map((tile) => tile.querySelector('.connect-card__title')?.textContent))
      .toEqual(['Linear', 'YouTrack', 'Discord']);
    expect(tiles.map((tile) => tile.querySelector('.connect-card__summary')?.textContent))
      .toEqual(['Connect', 'Paste a token', 'Admin sets this up']);
    // OAuth is a navigation; a paste opens the form under the grid; an
    // admin-configured provider is a state, so its tile does not press.
    expect(tiles[0]?.tagName).toBe('A');
    expect(tiles[0]?.getAttribute('href')).toBe('/connect/linear/start');
    expect((tiles[2] as HTMLButtonElement).disabled).toBe(true);
    await act(async () => click(tiles[1]!));
    await settle();
    expect(view.container.querySelector('.connect-form')).not.toBeNull();
    await view.unmount();
  });
});

/** The provider connect surface as production hosts it: expanded inside a
 * workspace provider row. It used to be reachable from the settings connect
 * picker too; that picker is gone, and these are its behaviours that survived
 * — the admin-configured note, and the instance-URL collection YouTrack needs. */
describe('provider connect surface (workspace rows)', () => {
  const rowProps = {
    workspaceId: 'workspace-one',
    connected: [] as readonly string[],
    focusProvider: null,
    focusVersion: 0,
    onConnected: () => undefined,
    onDisconnected: () => undefined,
  };

  function mintedLease(connection: string): CredentialLeaseView {
    return {
      id: `lease-${connection}`,
      workspaceId: 'workspace-one',
      boxId: null,
      connection,
      userId: 'member-one',
      scopes: [],
      mode: 'proxy',
      issuedAt: 1,
      expiresAt: 2_000,
      state: 'active',
    };
  }

  /** The whole tile is the control, so pressing it is what opens it. */
  function expand(container: ParentNode, title: string): Element {
    const row = [...container.querySelectorAll('.wsc-tile')]
      .find((candidate) => candidate.querySelector('strong')?.textContent === title);
    if (row === undefined) throw new Error(`no provider tile for ${title}`);
    const main = row.querySelector('.wsc-tile__main');
    if (main === null) throw new Error(`no tile button for ${title}`);
    return main;
  }

  it('explains admin-configured providers are an organization credential', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({
        providers: [
          adminEntry('tracker', 'Acme Tracker', true),
          { ...grantOnlyEntry('corp-sso', 'Corp SSO'), personalTokenLabel: null, oauthAvailable: true },
        ],
      })),
    });
    const view = await render(<WorkspaceProviderRows client={wire} {...rowProps} />);
    await settle();

    await act(async () => click(expand(view.container, 'Acme Tracker')));
    expect(view.container.querySelector('.connect-form')).toBeNull();
    expect(view.container.textContent).toContain('An admin stores one Acme Tracker key for everyone');
    expect(view.container.textContent).toContain('organization credential');
    expect(view.container.textContent).not.toContain('template page');
    expect(view.container.textContent).not.toContain('Connecting requires OAuth');

    await act(async () => click(expand(view.container, 'Corp SSO')));
    expect(view.container.textContent).toContain('Connecting requires OAuth');
    await view.unmount();
  });

  it('collects the instance URL on a first paste and sends it on the grant', async () => {
    const pastes: [string, unknown][] = [];
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({
        providers: [patEntry('youtrack-pat', 'YouTrack PAT')],
      })),
      putConnectionGrant: vi.fn(async (provider: string, input: PutUserGrantRequest) => {
        pastes.push([provider, input]);
      }),
      mintWorkspaceConnection: vi.fn(async (_id: string, connection: string) => ({
        lease: mintedLease(connection),
      })),
    });
    const view = await render(<WorkspaceProviderRows client={wire} {...rowProps} />);
    await settle();
    await act(async () => click(expand(view.container, 'YouTrack PAT')));

    const baseUrl = view.container.querySelector<HTMLInputElement>('input[name="baseUrl"]');
    const token = view.container.querySelector<HTMLInputElement>('input[name="token"]');
    if (baseUrl === null || token === null) throw new Error('paste inputs are missing');
    expect(baseUrl.getAttribute('type')).toBe('url');
    expect(baseUrl.required).toBe(true);
    await act(async () => {
      typeInto(baseUrl, 'https://acme.youtrack.example');
      typeInto(token, 'perm:test-only-token');
      view.container.querySelector('.connect-form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(pastes).toEqual([[
      'youtrack-pat',
      {
        manifestId: 'youtrack-pat',
        token: 'perm:test-only-token',
        vendor: { baseUrl: 'https://acme.youtrack.example' },
      },
    ]]);
    await view.unmount();
  });

  it('locks the instance URL to the org row and leaves it off the paste', async () => {
    const pastes: [string, unknown][] = [];
    const orgRow: ConnectionView = {
      name: 'youtrack-pat',
      provider: 'youtrack-pat',
      kind: 'static',
      custody: 'proxy',
      status: 'active',
      createdBy: 'first-member',
      proxyBaseUrl: 'https://acme.youtrack.example',
    };
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({
        providers: [patEntry('youtrack-pat', 'YouTrack PAT')],
      })),
      listConnections: vi.fn(async () => ({ connections: [orgRow] })),
      putConnectionGrant: vi.fn(async (provider: string, input: PutUserGrantRequest) => {
        pastes.push([provider, input]);
      }),
      mintWorkspaceConnection: vi.fn(async (_id: string, connection: string) => ({
        lease: mintedLease(connection),
      })),
    });
    const view = await render(<WorkspaceProviderRows client={wire} {...rowProps} />);
    await settle();
    await act(async () => click(expand(view.container, 'YouTrack PAT')));

    // The instance is already known org-wide: shown, not asked for, and the
    // grant inherits it because the locked field is never submitted.
    expect(view.container.querySelector('input[name="baseUrl"]')).toBeNull();
    const locked = [...view.container.querySelectorAll<HTMLInputElement>('.connect-field input')]
      .find((input) => input.value === 'https://acme.youtrack.example');
    expect(locked?.readOnly).toBe(true);
    const token = view.container.querySelector<HTMLInputElement>('input[name="token"]');
    if (token === null) throw new Error('token input is missing');
    await act(async () => {
      typeInto(token, 'perm:second-member-token');
      view.container.querySelector('.connect-form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(pastes).toEqual([[
      'youtrack-pat',
      {
        manifestId: 'youtrack-pat',
        token: 'perm:second-member-token',
      },
    ]]);
    await view.unmount();
  });
});
