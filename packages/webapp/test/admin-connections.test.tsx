import type {
  CatalogEntryView,
  ConnectionView,
  PutConnectionRequest,
  PutUserGrantRequest,
} from '@blitzos/schema';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneClient } from '../src/api.js';
import { adminConnectionInput, ProviderAdminForm } from '../src/connections/ProviderAdminForm.js';
import { ConnectionsPanel } from '../src/settings/ConnectionsPanel.js';
import { OrgConnectionsSection } from '../src/settings/OrgConnectionsSection.js';
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
    listGithubRepositories: vi.fn(async () => ({ repositories: [] })),
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
      app: null,
    },
    environmentNames: [],
  };
}

/** The GitHub App shape: app id + installation id + private-key file, PUT
 * as kind app-jwt. Coexists with member OAuth on the same manifest. */
function appEntry(id: string, title: string): CatalogEntryView {
  const entry = adminEntry(id, title, false);
  return {
    ...entry,
    oauthAvailable: true,
    adminForm: {
      rootLabel: 'App private key (.pem)',
      rootHelp: 'Generate a private key in the vendor app settings and drop the downloaded file here.',
      placements: [{ kind: 'env', name: 'GH_TOKEN', fill: 'token' }],
      proxy: null,
      app: { appIdLabel: 'App ID', installationIdLabel: 'Installation ID' },
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

  it('renders the manifest-decided fields for proxy custody', async () => {
    const view = await render(
      <ProviderAdminForm
        entry={adminEntry('tracker', 'Acme Tracker', true)}
        saving={false}
        configured={false}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    const labels = [...view.container.querySelectorAll('.connect-field__label')]
      .map((label) => label.textContent);
    expect(labels).toEqual(['Instance URL', 'Service token']);
    expect(view.container.querySelector('input[name="baseUrl"]')?.getAttribute('type')).toBe('url');
    expect(view.container.querySelector('input[name="root"]')?.getAttribute('type')).toBe('password');
    expect(view.container.textContent).toContain('Create it in the vendor console');
    await view.unmount();
  });

  it('submits the exact static PUT body the control plane stores', async () => {
    const bodies = await putBody(adminEntry('tracker', 'Acme Tracker', true), (container) => {
      const baseUrl = container.querySelector<HTMLInputElement>('input[name="baseUrl"]');
      const root = container.querySelector<HTMLInputElement>('input[name="root"]');
      if (baseUrl === null || root === null) throw new Error('form inputs are missing');
      typeInto(baseUrl, 'https://tracker.example');
      typeInto(root, 'perm:test-only-token');
    });
    // The same shape the control-plane suite PUTs directly: manifest-decided
    // custody and placements, admin-supplied root and instance URL.
    expect(bodies).toEqual([{
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
    }]);
  });

  it('omits the proxy block and the URL field for cp custody', async () => {
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

  it('submits the app-jwt body for the GitHub App shape from a dropped key file', async () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\ntest-only\n-----END RSA PRIVATE KEY-----';
    const bodies = await putBody(appEntry('github', 'GitHub'), async (container) => {
      fillAppIds(container);
      // The primary path is the drop zone: no textarea is mounted for it.
      expect(container.querySelector('textarea[name="root"]')).toBeNull();
      await act(async () => {
        dropKeyFile(
          keyDropZone(container),
          new File([pem], 'my-app.2026-08-23.private-key.pem'),
        );
      });
      await settle();
      expect(container.textContent).toContain('my-app.2026-08-23.private-key.pem');
      expect(container.textContent).toContain('key loaded');
    });
    // The canonical app-jwt PUT: ids in the config, the file's PEM as the
    // root, no placements — the minter's defaults are the app credential's
    // surface. Exactly the shape the old paste path sent.
    expect(bodies).toEqual([{
      provider: 'github',
      kind: 'app-jwt',
      custody: 'cp',
      config: { app_id: '123456', installation_id: '987654' },
      root: pem,
    }]);
  });

  it('loads a browsed file through the hidden picker', async () => {
    const pem = '-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----';
    const bodies = await putBody(appEntry('github', 'GitHub'), async (container) => {
      fillAppIds(container);
      const picker = container.querySelector<HTMLInputElement>('input[type="file"]');
      if (picker === null) throw new Error('file picker is missing');
      expect(picker.getAttribute('accept')).toBe('.pem');
      // A picker's FileList cannot be assigned for real, so the test stubs
      // it and fires change exactly as the browser would after a pick.
      Object.defineProperty(picker, 'files', {
        configurable: true,
        value: [new File([pem], 'browsed.pem')],
      });
      await act(async () => {
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await settle();
      expect(container.textContent).toContain('browsed.pem');
      expect(container.textContent).toContain('key loaded');
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.root).toBe(pem);
  });

  it('refuses encrypted key files with a message, not a submit', async () => {
    const view = await render(
      <ProviderAdminForm
        entry={appEntry('github', 'GitHub')}
        saving={false}
        configured={false}
        onCancel={() => undefined}
        onSubmit={() => { throw new Error('an encrypted key must never submit'); }}
      />,
    );
    await act(async () => {
      dropKeyFile(keyDropZone(view.container), new File(
        ['-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----'],
        'encrypted.pem',
      ));
    });
    await settle();
    expect(view.container.textContent).toContain('Encrypted keys are not supported');
    expect(view.container.textContent).not.toContain('key loaded');

    // The legacy dialect: PKCS#1 armor around a Proc-Type header.
    await act(async () => {
      dropKeyFile(keyDropZone(view.container), new File(
        ['-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nAAAA\n-----END RSA PRIVATE KEY-----'],
        'legacy-encrypted.pem',
      ));
    });
    await settle();
    expect(view.container.textContent).toContain('Encrypted keys are not supported');
    expect(view.container.textContent).not.toContain('key loaded');
    await view.unmount();
  });

  it('refuses files that are not a PEM key and files too big to be one', async () => {
    const view = await render(
      <ProviderAdminForm
        entry={appEntry('github', 'GitHub')}
        saving={false}
        configured={false}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    await act(async () => {
      dropKeyFile(keyDropZone(view.container), new File(['just notes'], 'notes.txt'));
    });
    await settle();
    expect(view.container.textContent).toContain('not a private key');

    await act(async () => {
      dropKeyFile(keyDropZone(view.container), new File(
        ['a'.repeat(17 * 1024)],
        'huge.pem',
      ));
    });
    await settle();
    expect(view.container.textContent).toContain('too large');
    expect(view.container.textContent).not.toContain('key loaded');
    await view.unmount();
  });

  it('keeps the paste path behind a toggle and submits the pasted key', async () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\npasted-test-only\n-----END RSA PRIVATE KEY-----';
    const bodies = await putBody(appEntry('github', 'GitHub'), async (container) => {
      fillAppIds(container);
      await act(async () => {
        click(buttonByText(container, 'Paste the key text instead'));
      });
      const root = container.querySelector<HTMLTextAreaElement>('textarea[name="root"]');
      if (root === null) throw new Error('paste textarea is missing');
      typeIntoTextArea(root, pem);
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.root).toBe(pem);
  });

  it('clears a loaded key and refuses to save without one', async () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\ntest-only\n-----END RSA PRIVATE KEY-----';
    const bodies: PutConnectionRequest[] = [];
    const view = await render(
      <ProviderAdminForm
        entry={appEntry('github', 'GitHub')}
        saving={false}
        configured={false}
        onCancel={() => undefined}
        onSubmit={(input) => bodies.push(input)}
      />,
    );
    fillAppIds(view.container);
    await act(async () => {
      dropKeyFile(keyDropZone(view.container), new File([pem], 'app.pem'));
    });
    await settle();
    expect(view.container.textContent).toContain('key loaded');
    await act(async () => {
      click(buttonByText(view.container, 'Clear'));
    });
    expect(view.container.textContent).not.toContain('key loaded');
    expect(view.container.textContent).toContain('Drop the .pem file here');
    await act(async () => {
      click(buttonByText(view.container, 'Save'));
    });
    expect(bodies).toEqual([]);
    expect(view.container.textContent).toContain('Add the private key');
    await view.unmount();
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

describe('connect picker (workspace surface)', () => {
  it('explains admin-configured providers point at the template page', async () => {
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
    expect(view.container.textContent).toContain('template page');
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
      putConnectionGrant: vi.fn(async (provider: string, input: PutUserGrantRequest) => {
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
      },
    ]]);
    await view.unmount();
  });
});
