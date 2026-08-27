import type {
  CatalogEntryView,
  ConnectionView,
  CredentialLeaseView,
  PutConnectionRequest,
  PutUserGrantRequest,
} from '@blitzos/schema';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneClient } from '../src/api.js';
import { adminConnectionInput, ProviderAdminForm } from '../src/connections/ProviderAdminForm.js';
import { WorkspaceProviderRows } from '../src/connections/WorkspaceProviderRows.js';
import { ConnectionsPanel } from '../src/settings/ConnectionsPanel.js';
import { OrgConnectionsSection } from '../src/settings/OrgConnectionsSection.js';
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
    orgUsage: vi.fn(async () => ({ seatsUsed: 1, seatLimit: null, vmsUsed: 0, vmLimit: 10 })),
    billing: vi.fn(async () => { throw new Error('unused'); }),
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

/** The GitHub App shape: app id + installation id + private-key file, PUT */
function appEntry(id: string, title: string): CatalogEntryView {
  const entry = adminEntry(id, title, false);
  return {
    ...entry,
    oauthAvailable: true,
    adminForm: {
      rootLabel: 'App private key (.pem)',
      rootHelp: 'Generate a private key in the vendor app settings and drop the downloaded file here.',
      placements: [{ kind: 'env', name: 'GH_TOKEN', fill: 'token' }],
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

const setTextAreaValue = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  'value',
)?.set;

function typeIntoTextArea(textarea: HTMLTextAreaElement, value: string): void {
  if (setTextAreaValue === undefined) throw new Error('textarea value setter is unavailable');
  setTextAreaValue.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Drops a file on the key drop zone the way a browser would: a bubbling
 * drop event whose dataTransfer carries the file list. */
function dropKeyFile(zone: Element, file: File): void {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { files: [file], items: [], types: ['Files'] },
  });
  zone.dispatchEvent(event);
}

function keyDropZone(container: HTMLElement): Element {
  const zone = container.querySelector('.connect-drop');
  if (zone === null) throw new Error('key drop zone is missing');
  return zone;
}

function fillAppIds(container: HTMLElement): void {
  const appId = container.querySelector<HTMLInputElement>('input[name="appId"]');
  const installationId = container.querySelector<HTMLInputElement>('input[name="installationId"]');
  if (appId === null || installationId === null) {
    throw new Error('app form inputs are missing');
  }
  typeInto(appId, '123456');
  typeInto(installationId, '987654');
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

describe('provider admin form', () => {
  const putBody = (
    entry: CatalogEntryView,
    fill: (container: HTMLElement) => void | Promise<void>,
  ) => {
    return (async () => {
      const bodies: PutConnectionRequest[] = [];
      const view = await render(
        <ProviderAdminForm
          entry={entry}
          saving={false}
          configured={false}
          onCancel={() => undefined}
          onSubmit={(input) => bodies.push(input)}
        />,
      );
      await fill(view.container);
      // The component renders no <form> (its host may be one), so saving is
      // the Save button, not a submit event.
      expect(view.container.querySelector('form')).toBeNull();
      await act(async () => {
        click(buttonByText(view.container, 'Save'));
      });
      await view.unmount();
      return bodies;
    })();
  };

  /** The static form is one field: the root. It used to grow an instance-URL
   * field for proxy custody, which no manifest ever asked for — the admin path
   * and proxy custody have never met on the same provider. */
  it('renders the manifest-decided fields for a static root', async () => {
    const view = await render(
      <ProviderAdminForm
        entry={adminEntry('discord', 'Discord', false)}
        saving={false}
        configured={false}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    const labels = [...view.container.querySelectorAll('.connect-field__label')]
      .map((label) => label.textContent);
    expect(labels).toEqual(['Bot token']);
    expect(view.container.querySelector('input[name="baseUrl"]')).toBeNull();
    expect(view.container.querySelector('input[name="root"]')?.getAttribute('type')).toBe('password');
    expect(view.container.textContent).toContain('Create it in the vendor console');
    await view.unmount();
  });

  /** The same shape the control-plane suite PUTs directly: manifest-decided
   * custody and placements, admin-supplied root, and no proxy block anywhere. */
  it('submits the exact static PUT body the control plane stores', async () => {
    const bodies = await putBody(adminEntry('discord', 'Discord', false), (container) => {
      expect(container.querySelector('input[name="baseUrl"]')).toBeNull();
      const root = container.querySelector<HTMLInputElement>('input[name="root"]');
      if (root === null) throw new Error('root input is missing');
      typeInto(root, 'test-only-bot-token');
    });
    expect(bodies).toEqual([{
      provider: 'discord',
      kind: 'static',
      custody: 'cp',
      config: {
        placements: [{ kind: 'env', name: 'DISCORD_BOT_TOKEN', fill: 'token' }],
      },
      root: 'test-only-bot-token',
    }]);
  });

  it('parses nothing for a provider without an admin form', () => {
    expect(adminConnectionInput(grantOnlyEntry('linear', 'Linear'), new FormData())).toBeNull();
  });

  it('saves on Enter in a field without any native submit', async () => {
    const bodies: PutConnectionRequest[] = [];
    const view = await render(
      <ProviderAdminForm
        entry={adminEntry('discord', 'Discord', false)}
        saving={false}
        configured={false}
        onCancel={() => undefined}
        onSubmit={(input) => bodies.push(input)}
      />,
    );
    const root = view.container.querySelector<HTMLInputElement>('input[name="root"]');
    if (root === null) throw new Error('root input is missing');
    typeInto(root, 'test-only-bot-token');
    await act(async () => {
      root.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.root).toBe('test-only-bot-token');
    await view.unmount();
  });

  it('refuses to save while a required field is empty', async () => {
    const bodies: PutConnectionRequest[] = [];
    const view = await render(
      <ProviderAdminForm
        entry={adminEntry('discord', 'Discord', false)}
        saving={false}
        configured={false}
        onCancel={() => undefined}
        onSubmit={(input) => bodies.push(input)}
      />,
    );
    await act(async () => {
      click(buttonByText(view.container, 'Save'));
    });
    expect(bodies).toEqual([]);
    await view.unmount();
  });
});

describe('org connections section (settings, revoke-only)', () => {
  const storedRow: ConnectionView = {
    name: 'discord',
    provider: 'discord',
    kind: 'static',
    custody: 'cp',
    status: 'active',
    createdBy: 'admin',
    proxyBaseUrl: null,
    orgCredential: true,
  };
  const declaredRow: ConnectionView = {
    name: 'youtrack',
    provider: 'youtrack',
    kind: 'static',
    custody: 'proxy',
    status: 'active',
    createdBy: 'first-member',
    proxyBaseUrl: 'https://acme.youtrack.example',
    orgCredential: false,
  };

  it('lists only sealed org credentials, never member declarations', async () => {
    const wire = client({
      listConnections: vi.fn(async () => ({ connections: [storedRow, declaredRow] })),
    });
    const view = await render(<OrgConnectionsSection client={wire} />);
    await settle();
    const section = view.container.querySelector('[aria-label="Organization connections"]');
    expect(section?.textContent).toContain('discord');
    expect(section?.textContent).not.toContain('youtrack');
    // The add path lives on the template page now; this section only names it.
    expect(section?.textContent).toContain('template page');
    expect(section?.querySelector('form')).toBeNull();
    await view.unmount();
  });

  it('revokes an org credential only after confirmation', async () => {
    const deleteConnection = vi.fn(async () => undefined);
    const wire = client({
      listConnections: vi.fn(async () => ({ connections: [storedRow] })),
      deleteConnection,
    });
    const view = await render(<OrgConnectionsSection client={wire} />);
    await settle();
    await act(async () => click(buttonByText(view.container, 'Revoke')));
    expect(deleteConnection).not.toHaveBeenCalled();
    await act(async () => click(buttonByText(document.body, 'Revoke credential')));
    await settle();
    expect(deleteConnection).toHaveBeenCalledWith('discord');
    await view.unmount();
  });

  it('draws nothing when the org stores no credential', async () => {
    const wire = client({
      listConnections: vi.fn(async () => ({ connections: [declaredRow] })),
    });
    const view = await render(<OrgConnectionsSection client={wire} />);
    await settle();
    expect(view.container.querySelector('[aria-label="Organization connections"]')).toBeNull();
    await view.unmount();
  });
});

describe('settings connections panel (revoke-only)', () => {
  it('hosts no picker and no config form; grants keep revoke and OAuth re-auth', async () => {
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
    // The connect surfaces moved out: members connect in the workspace
    // drawer, admins configure on the template page.
    expect(view.container.querySelector('.connect-picker')).toBeNull();
    expect(view.container.querySelector('.connect-form')).toBeNull();
    // Rotation stays: an OAuth grant re-runs the dance from a plain link; a
    // pasted key has no re-auth here — it is re-pasted in a workspace.
    const reauth = [...view.container.querySelectorAll('a')]
      .filter((anchor) => anchor.textContent === 'Re-auth');
    expect(reauth.map((anchor) => anchor.getAttribute('href')))
      .toEqual(['/connect/linear/start']);
    const revokes = [...view.container.querySelectorAll('button')]
      .filter((button) => button.textContent === 'Revoke');
    expect(revokes.length).toBe(2);
    await view.unmount();
  });

  it('shows the org section for admins and never for members', async () => {
    const stored: ConnectionView = {
      name: 'discord',
      provider: 'discord',
      kind: 'static',
      custody: 'cp',
      status: 'active',
      createdBy: 'admin',
      proxyBaseUrl: null,
      orgCredential: true,
    };
    const wire = client({
      listConnections: vi.fn(async () => ({ connections: [stored] })),
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

  it('explains admin-configured providers point at the template page', async () => {
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
    expect(view.container.textContent).toContain('template page');
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
      orgCredential: false,
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
