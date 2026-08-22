import type {
  CatalogEntryView,
  ConnectionView,
  PutConnectionRequest,
} from '@blitzos/schema';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneClient } from '../src/api.js';
import { AdminConnectionsSection } from '../src/settings/AdminConnectionsSection.js';
import { ConnectionsPanel } from '../src/settings/ConnectionsPanel.js';
import { ConnectPicker } from '../src/settings/ConnectPicker.js';
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
    putConnectionGrant: vi.fn(async () => undefined),
    deleteConnectionGrant: vi.fn(async () => undefined),
    listProviderHealth: vi.fn(async () => ({ providers: [] })),
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
    docsUrl: `https://example.com/${id}`,
    custody: proxy ? 'proxy' : 'cp',
    rotation: 'none',
    oauthAvailable: false,
    oauthConfigured: false,
    personalTokenLabel: null,
    personalTokenHelp: null,
    personalTokenBaseUrlLabel: null,
    needsVendorConfig: false,
    adminForm: {
      rootLabel: proxy ? 'Service token' : 'Bot token',
      rootHelp: 'Create it in the vendor console under a service account.',
      placements: proxy
        ? [
            { kind: 'env', name: 'TRACKER_TOKEN', fill: 'token' },
            { kind: 'env', name: 'TRACKER_BASE_URL', fill: 'proxy-url' },
          ]
        : [{ kind: 'env', name: 'DISCORD_BOT_TOKEN', fill: 'token' }],
      proxy: proxy
        ? {
            baseUrlLabel: 'Instance URL',
            tokenHeader: 'Authorization',
            tokenPrefix: 'Bearer ',
          }
        : null,
    },
    environmentNames: [],
    scopes: [],
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

function buttonByText(container: Element, text: string): Element {
  const match = [...container.querySelectorAll('button')]
    .find((button) => button.textContent === text);
  if (match === undefined) throw new Error(`no button reads "${text}"`);
  return match;
}

describe('admin connections section', () => {
  it('renders one manifest-driven form per admin-custody provider', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({
        providers: [
          adminEntry('tracker', 'Acme Tracker', true),
          adminEntry('discord', 'Discord', false),
          grantOnlyEntry('linear', 'Linear'),
        ],
      })),
    });
    const view = await render(<AdminConnectionsSection client={wire} />);
    await settle();

    const section = view.container.querySelector('[aria-label="Organization connections"]');
    expect(section?.textContent).toContain('Acme Tracker');
    expect(section?.textContent).toContain('Discord');
    // Grant-backed providers belong to the picker, not to org configuration.
    expect(section?.textContent).not.toContain('Linear');

    await act(async () => click(buttonByText(view.container, 'Configure')));
    const labels = [...view.container.querySelectorAll('.connect-field__label')]
      .map((label) => label.textContent);
    expect(labels).toEqual(['Instance URL', 'Service token']);
    expect(view.container.querySelector('input[name="baseUrl"]')?.getAttribute('type')).toBe('url');
    expect(view.container.querySelector('input[name="root"]')?.getAttribute('type')).toBe('password');
    expect(view.container.textContent).toContain('Create it in the vendor console');
    await view.unmount();
  });

  it('submits the exact PUT body the control plane stores and flips to configured', async () => {
    const rows: ConnectionView[] = [];
    const bodies: [string, PutConnectionRequest][] = [];
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({
        providers: [adminEntry('tracker', 'Acme Tracker', true)],
      })),
      listConnections: vi.fn(async () => ({ connections: [...rows] })),
      putConnection: vi.fn(async (name: string, input: PutConnectionRequest) => {
        bodies.push([name, input]);
        rows.push({
          name: 'tracker',
          provider: 'tracker',
          kind: 'static',
          custody: 'proxy',
          status: 'active',
          createdBy: 'admin',
          proxyBaseUrl: 'https://tracker.example',
        });
      }),
    });
    const view = await render(<AdminConnectionsSection client={wire} />);
    await settle();
    await act(async () => click(buttonByText(view.container, 'Configure')));

    const baseUrl = view.container.querySelector<HTMLInputElement>('input[name="baseUrl"]');
    const root = view.container.querySelector<HTMLInputElement>('input[name="root"]');
    if (baseUrl === null || root === null) throw new Error('form inputs are missing');
    await act(async () => {
      typeInto(baseUrl, 'https://tracker.example');
      typeInto(root, 'perm:test-only-token');
      view.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    // The same shape the control-plane suite PUTs directly: manifest-decided
    // custody and placements, admin-supplied root and instance URL.
    expect(bodies).toEqual([[
      'tracker',
      {
        provider: 'tracker',
        kind: 'static',
        custody: 'proxy',
        config: {
          placements: [
            { kind: 'env', name: 'TRACKER_TOKEN', fill: 'token' },
            { kind: 'env', name: 'TRACKER_BASE_URL', fill: 'proxy-url' },
          ],
          proxy: {
            base_url: 'https://tracker.example',
            token_header: 'Authorization',
            token_prefix: 'Bearer ',
          },
        },
        root: 'perm:test-only-token',
      },
    ]]);
    expect(view.container.textContent).toContain('configured');
    expect(view.container.textContent).toContain('Reconfigure');
    await view.unmount();
  });

  it('omits the proxy block and the URL field for cp custody', async () => {
    const bodies: PutConnectionRequest[] = [];
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({
        providers: [adminEntry('discord', 'Discord', false)],
      })),
      putConnection: vi.fn(async (_name: string, input: PutConnectionRequest) => {
        bodies.push(input);
      }),
    });
    const view = await render(<AdminConnectionsSection client={wire} />);
    await settle();
    await act(async () => click(buttonByText(view.container, 'Configure')));
    expect(view.container.querySelector('input[name="baseUrl"]')).toBeNull();

    const root = view.container.querySelector<HTMLInputElement>('input[name="root"]');
    if (root === null) throw new Error('root input is missing');
    await act(async () => {
      typeInto(root, 'test-only-bot-token');
      view.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(bodies).toEqual([{
      provider: 'discord',
      kind: 'static',
      custody: 'cp',
      config: {
        placements: [{ kind: 'env', name: 'DISCORD_BOT_TOKEN', fill: 'token' }],
      },
      root: 'test-only-bot-token',
    }]);
    await view.unmount();
  });

  it('marks an already-stored connection configured before any click', async () => {
    const stored: ConnectionView = {
      name: 'discord',
      provider: 'discord',
      kind: 'static',
      custody: 'cp',
      status: 'active',
      createdBy: 'admin',
      proxyBaseUrl: null,
    };
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({
        providers: [adminEntry('discord', 'Discord', false)],
      })),
      listConnections: vi.fn(async () => ({ connections: [stored] })),
    });
    const view = await render(<AdminConnectionsSection client={wire} />);
    await settle();
    expect(view.container.textContent).toContain('configured');
    expect(view.container.textContent).toContain('Reconfigure');
    await view.unmount();
  });

  it('appears in the settings panel for admins and never for members', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({
        providers: [adminEntry('tracker', 'Acme Tracker', true)],
      })),
    });
    const asAdmin = await render(<ConnectionsPanel client={wire} admin />);
    await settle();
    expect(asAdmin.container.querySelector('[aria-label="Organization connections"]')).not.toBeNull();
    await asAdmin.unmount();

    const asMember = await render(<ConnectionsPanel client={wire} />);
    await settle();
    expect(asMember.container.querySelector('[aria-label="Organization connections"]')).toBeNull();
    await asMember.unmount();
  });

  it('explains admin-configured providers in the picker instead of demanding OAuth', async () => {
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({
        providers: [
          adminEntry('tracker', 'Acme Tracker', true),
          { ...grantOnlyEntry('corp-sso', 'Corp SSO'), personalTokenLabel: null, oauthAvailable: true },
        ],
      })),
    });
    const view = await render(<ConnectPicker client={wire} />);
    await settle();
    const cards = [...view.container.querySelectorAll('.connect-card')];

    const tracker = cards.find((card) => card.textContent?.includes('Acme Tracker'));
    if (tracker === undefined) throw new Error('Acme Tracker card is missing');
    await act(async () => click(tracker));
    expect(view.container.querySelector('.connect-form')).toBeNull();
    expect(view.container.textContent).toContain('An organization admin configures Acme Tracker once');
    expect(view.container.textContent).not.toContain('Connecting requires OAuth');

    const sso = cards.find((card) => card.textContent?.includes('Corp SSO'));
    if (sso === undefined) throw new Error('Corp SSO card is missing');
    await act(async () => click(sso));
    expect(view.container.textContent).toContain('Connecting requires OAuth');
    await view.unmount();
  });

  it('collects the instance URL on a first paste and sends it on the grant', async () => {
    const pastes: [string, unknown][] = [];
    const wire = client({
      listConnectionCatalog: vi.fn(async () => ({
        providers: [patEntry('youtrack-pat', 'YouTrack PAT')],
      })),
      putConnectionGrant: vi.fn(async (provider: string, input: unknown) => {
        pastes.push([provider, input]);
      }),
    });
    const view = await render(<ConnectPicker client={wire} />);
    await settle();
    const card = view.container.querySelector('.connect-card');
    if (card === null) throw new Error('provider card is missing');
    await act(async () => click(card));

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
        scopes: [],
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
      putConnectionGrant: vi.fn(async (provider: string, input: unknown) => {
        pastes.push([provider, input]);
      }),
    });
    const view = await render(<ConnectPicker client={wire} />);
    await settle();
    const card = view.container.querySelector('.connect-card');
    if (card === null) throw new Error('provider card is missing');
    await act(async () => click(card));

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
        scopes: [],
      },
    ]]);
    await view.unmount();
  });
});
