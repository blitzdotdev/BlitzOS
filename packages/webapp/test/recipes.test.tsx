import type { RecipeView, WorkspaceView } from '@blitzos/schema';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CloudApp from '../src/CloudApp.js';
import {
  ApiRequestError,
  createControlPlaneClient,
  type ControlPlaneClient,
} from '../src/api.js';
import type { TenantMe } from '../src/api-adapter.js';
import { CreateRecipeScreen } from '../src/files/CreateRecipeScreen.js';
import { RecipesHome } from '../src/files/RecipesHome.js';
import { TemplatesHome } from '../src/files/TemplatesHome.js';
import { SettingsPage } from '../src/SettingsPage.js';
import { standaloneResolver } from '../src/resolver.js';
import { render, settle } from './dom.js';
import { workspaceViewFixture } from './workspace-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

const templates = [{
  id: 'template-1',
  name: 'analysis starter',
  machineTypeId: 'cx23@fsn1',
  createdAt: 1,
  createdBy: { name: 'Ada Park', avatarUrl: null },
  environment: null,
  agentRuleId: null,
  isOrgDefault: false,
  folders: [],
  connections: [],
  repos: [],
}];

const recipe: RecipeView = {
  id: 'r-1',
  name: 'weekly report',
  templateId: 'template-1',
  harness: 'claude',
  model: 'claude-opus-5',
  prompt: 'Write the weekly report.',
};

function stub(extra?: (url: URL, init?: RequestInit) => Response | null) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const handled = extra?.(url, init);
    if (handled) return handled;
    if (url.pathname === '/workspace-recipes' && init?.method === undefined) {
      return Response.json({ recipes: [recipe] });
    }
    if (url.pathname === '/workspace-templates' && init?.method === undefined) {
      return Response.json({ templates });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
const setTextarea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
if (setInput === undefined || setSelect === undefined || setTextarea === undefined) {
  throw new Error('value setters unavailable');
}

function select(view: { container: HTMLElement }, label: string): HTMLSelectElement {
  const found = view.container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(found, label).not.toBeNull();
  return found!;
}

async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => {
    setSelect!.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function submit(view: { container: HTMLElement }) {
  await act(async () => {
    view.container.querySelector('form')?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

describe('recipes home', () => {
  it('lists name, harness, model, and template name, and deletes with confirm', async () => {
    const deleted: string[] = [];
    const fetcher = stub((url, init) => {
      if (url.pathname === '/workspace-recipes/r-1' && init?.method === 'DELETE') {
        deleted.push(url.pathname);
        return new Response(null, { status: 204 });
      }
      return null;
    });
    const onRunRecipe = vi.fn();
    const view = await render(
      <RecipesHome
        client={createControlPlaneClient('https://cp.example')}
        launching={false}
        onNewRecipe={() => undefined}
        onEditRecipe={() => undefined}
        onRunRecipe={onRunRecipe}
        onOpenRail={() => undefined}
      />,
    );
    await settle();

    const card = view.container.querySelector('.tpl-card')!;
    expect(card.textContent).toContain('weekly report');
    expect(card.textContent).toContain('Claude Code');
    expect(card.textContent).toContain('claude-opus-5');
    expect(card.textContent).toContain('analysis starter');

    const run = [...card.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Run'))!;
    await act(async () => { run.click(); });
    expect(onRunRecipe).toHaveBeenCalledWith(recipe);

    await act(async () => {
      card.querySelector<HTMLButtonElement>('.tpl-kebab')?.click();
    });
    const remove = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Delete recipe'))!;
    await act(async () => { remove.click(); });
    expect(deleted).toEqual([]);
    expect(view.container.querySelector('.webapp-confirmation-dialog')?.textContent)
      .toContain('Workspaces it already launched keep running');
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('.webapp-confirmation-confirm')?.click();
    });
    await settle();
    expect(deleted).toEqual(['/workspace-recipes/r-1']);
    expect(fetcher.mock.calls.filter(([input]) =>
      new URL(String(input)).pathname === '/workspace-recipes'))
      .toHaveLength(2);
    await view.unmount();
  });
});

describe('templates home', () => {
  it('badges the org-default template card', async () => {
    stub((url, init) => {
      if (url.pathname === '/workspace-templates' && init?.method === undefined) {
        return Response.json({ templates: [
          { ...templates[0], isOrgDefault: true },
          { ...templates[0], id: 'template-2', name: 'plain starter' },
        ] });
      }
      return null;
    });
    const view = await render(
      <TemplatesHome
        client={createControlPlaneClient('https://cp.example')}
        creating={false}
        onNewTemplate={() => undefined}
        onEditTemplate={() => undefined}
        onUseTemplate={() => undefined}
        onOpenRail={() => undefined}
      />,
    );
    await settle();

    const cards = [...view.container.querySelectorAll('.tpl-card')];
    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelector('.tpl-default-badge')?.textContent).toBe('Org default');
    expect(cards[1]?.querySelector('.tpl-default-badge')).toBeNull();
    await view.unmount();
  });

  it('surfaces the control-plane 409 naming the blocking recipes on delete failure', async () => {
    stub((url, init) => {
      if (url.pathname === '/workspace-templates/template-1' && init?.method === 'DELETE') {
        return Response.json(
          {
            error: 'delete the 2 recipes using this template first: weekly report, nightly audit',
            retryAction: null,
          },
          { status: 409 },
        );
      }
      return null;
    });
    const view = await render(
      <TemplatesHome
        client={createControlPlaneClient('https://cp.example')}
        creating={false}
        onNewTemplate={() => undefined}
        onEditTemplate={() => undefined}
        onUseTemplate={() => undefined}
        onOpenRail={() => undefined}
      />,
    );
    await settle();

    const card = view.container.querySelector('.tpl-card')!;
    expect(card.textContent).toContain('analysis starter');
    await act(async () => {
      card.querySelector<HTMLButtonElement>('.tpl-kebab')?.click();
    });
    const remove = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Delete template'))!;
    await act(async () => { remove.click(); });
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('.webapp-confirmation-confirm')?.click();
    });
    await settle();

    expect(view.container.querySelector('[role="alert"]')?.textContent)
      .toBe('delete the 2 recipes using this template first: weekly report, nightly audit');
    await view.unmount();
  });
});

describe('create recipe screen', () => {
  async function screenWith(fetcher = stub(), editRecipeId?: string) {
    const onSaved = vi.fn();
    const view = await render(
      <CreateRecipeScreen
        client={createControlPlaneClient('https://cp.example')}
        editRecipeId={editRecipeId}
        onSaved={onSaved}
        onCancel={() => undefined}
      />,
    );
    await settle();
    return { view, onSaved, fetcher };
  }

  it('offers only the harness provider models and posts the minimal body', async () => {
    const fetcher = stub((url, init) => {
      if (url.pathname === '/workspace-recipes' && init?.method === 'POST') {
        // SAFETY: The screen always sends a JSON body on this route.
        const body = JSON.parse(String(init.body)) as { name: string };
        return Response.json({ recipe: { id: 'r-2', ...body } }, { status: 201 });
      }
      return null;
    });
    const { view, onSaved } = await screenWith(fetcher);

    expect([...select(view, 'Model').options].map((option) => option.textContent)).toEqual([
      'Harness default',
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
    ]);
    expect([...select(view, 'Effort').options].map((option) => option.textContent)).toEqual([
      'Default', 'low', 'medium', 'high', 'xhigh', 'max',
    ]);

    const name = view.container.querySelector<HTMLInputElement>('input[aria-label="Recipe name"]')!;
    const prompt = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')!;
    await act(async () => {
      setInput!.call(name, 'nightly audit');
      name.dispatchEvent(new Event('input', { bubbles: true }));
      setTextarea!.call(prompt, 'Audit the dependencies.');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await choose(select(view, 'Workspace template'), 'template-1');
    await submit(view);

    const post = fetcher.mock.calls.find(([input, init]) => (
      new URL(String(input)).pathname === '/workspace-recipes' && init?.method === 'POST'
    ));
    // No model and no effort keys at all: absent means the harness default.
    expect(JSON.parse(String(post?.[1]?.body ?? '{}'))).toEqual({
      name: 'nightly audit',
      templateId: 'template-1',
      harness: 'claude',
      prompt: 'Audit the dependencies.',
    });
    expect(onSaved).toHaveBeenCalledOnce();
    await view.unmount();
  });

  it('drops a model and effort the next harness cannot run', async () => {
    const { view } = await screenWith();
    await choose(select(view, 'Model'), 'claude-opus-5');
    // `max` is claude-wide but outside the codex base, so the switch drops it.
    await choose(select(view, 'Effort'), 'max');

    await choose(select(view, 'Harness'), 'codex');
    expect(select(view, 'Model').value).toBe('');
    expect(select(view, 'Effort').value).toBe('');
    // No model pinned: the codex provider base.
    expect([...select(view, 'Effort').options].map((option) => option.textContent)).toEqual([
      'Default', 'low', 'medium', 'high', 'xhigh',
    ]);

    await view.unmount();
  });

  it('scopes efforts to the pinned codex model and resets an orphaned tier', async () => {
    const { view } = await screenWith();
    await choose(select(view, 'Harness'), 'codex');
    await choose(select(view, 'Model'), 'gpt-5.6-sol');
    await choose(select(view, 'Effort'), 'ultra');

    // terra also grants ultra, so the pick survives that model change.
    await choose(select(view, 'Model'), 'gpt-5.6-terra');
    expect(select(view, 'Effort').value).toBe('ultra');

    // gpt-5.5 is base-only: the list narrows and the orphaned ultra resets.
    await choose(select(view, 'Model'), 'gpt-5.5');
    expect(select(view, 'Effort').value).toBe('');
    expect([...select(view, 'Effort').options].map((option) => option.textContent)).toEqual([
      'Default', 'low', 'medium', 'high', 'xhigh',
    ]);

    // luna grants max but not ultra.
    await choose(select(view, 'Model'), 'gpt-5.6-luna');
    expect([...select(view, 'Effort').options].map((option) => option.textContent)).toEqual([
      'Default', 'low', 'medium', 'high', 'xhigh', 'max',
    ]);
    // A base tier survives dropping back to the harness default.
    await choose(select(view, 'Effort'), 'xhigh');
    await choose(select(view, 'Model'), '');
    expect(select(view, 'Effort').value).toBe('xhigh');
    await view.unmount();
  });

  it('prefills edit mode from the recipe and saves through PUT', async () => {
    const fetcher = stub((url, init) => {
      if (url.pathname === '/workspace-recipes/r-1' && init?.method === undefined) {
        return Response.json({ recipe });
      }
      if (url.pathname === '/workspace-recipes/r-1' && init?.method === 'PUT') {
        // SAFETY: The screen always sends a JSON body on this route.
        const body = JSON.parse(String(init.body)) as { name: string };
        return Response.json({ recipe: { ...recipe, ...body } });
      }
      return null;
    });
    const { view, onSaved } = await screenWith(fetcher, 'r-1');

    expect(view.container.textContent).toContain('Edit recipe');
    const name = view.container.querySelector<HTMLInputElement>('input[aria-label="Recipe name"]')!;
    expect(name.value).toBe('weekly report');
    expect(select(view, 'Workspace template').value).toBe('template-1');
    expect(select(view, 'Harness').value).toBe('claude');
    expect(select(view, 'Model').value).toBe('claude-opus-5');
    expect(view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')?.value)
      .toBe('Write the weekly report.');

    await act(async () => {
      setInput!.call(name, 'weekly report v2');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await submit(view);

    const put = fetcher.mock.calls.find(([input, init]) => (
      new URL(String(input)).pathname === '/workspace-recipes/r-1' && init?.method === 'PUT'
    ));
    expect(JSON.parse(String(put?.[1]?.body ?? '{}'))).toEqual({
      name: 'weekly report v2',
      templateId: 'template-1',
      harness: 'claude',
      model: 'claude-opus-5',
      prompt: 'Write the weekly report.',
    });
    expect(onSaved).toHaveBeenCalledOnce();
    await view.unmount();
  });
});

const tenantMe: TenantMe = {
  identity: {
    id: 'user-1',
    email: 'ada@example.com',
    name: 'Ada Park',
    avatarUrl: null,
    platformOperator: false,
  },
  membership: { id: 'membership-1', role: 'admin' },
  org: { id: 'org-1', slug: 'acme', name: 'Acme', vmLimit: 10 },
  organizations: [{
    membership: { id: 'membership-1', role: 'admin' },
    org: { id: 'org-1', slug: 'acme', name: 'Acme', vmLimit: 10 },
  }],
};

const launchedWorkspace: WorkspaceView = workspaceViewFixture({
  id: 'workspace-new',
  name: 'weekly report',
  phase: 'creating',
  retryAction: 'poll',
  canObserve: false,
  launchable: false,
  owner: { name: 'Ada Park', avatarUrl: null },
});

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
    deleteFolderObject: vi.fn(async () => undefined),
    listAgentRules: vi.fn(async () => ({ rules: [] })),
    putAgentRule: vi.fn(async () => { throw new Error('unused'); }),
    deleteAgentRule: vi.fn(async () => undefined),
    listWorkspaceTemplates: vi.fn(async () => ({ templates })),
    createWorkspaceTemplate: vi.fn(async () => { throw new Error('unused'); }),
    updateWorkspaceTemplate: vi.fn(async () => { throw new Error('unused'); }),
    deleteWorkspaceTemplate: vi.fn(async () => undefined),
    listRecipes: vi.fn(async () => ({ recipes: [recipe] })),
    getRecipe: vi.fn(async () => ({ recipe })),
    createRecipe: vi.fn(async () => { throw new Error('unused'); }),
    updateRecipe: vi.fn(async () => { throw new Error('unused'); }),
    deleteRecipe: vi.fn(async () => undefined),
    launchRecipe: vi.fn(async () => ({ workspace: launchedWorkspace })),
    getUsageCapture: vi.fn(async () => ({ enabled: false, folderId: null })),
    orgUsage: vi.fn(async () => ({ seatsUsed: 1, seatLimit: null, vmsUsed: 0, vmLimit: 10, platformCompute: false })),
    billing: vi.fn(async () => { throw new Error('unused'); }),
    putUsageCapture: vi.fn(async (enabled: boolean) => ({ enabled, folderId: null })),
    logout: vi.fn(async () => undefined),
    me: vi.fn(async () => ({
      user: { ...tenantMe.identity, platformOperator: false },
      membership: { ...tenantMe.membership, status: 'active' as const },
      org: tenantMe.org,
      organizations: [{
        membership: { ...tenantMe.membership, status: 'active' as const },
        org: tenantMe.org,
      }],
    })),
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
    mintWorkspaceConnection: vi.fn(async () => { throw new Error('unused'); }),
    disconnectWorkspaceConnection: vi.fn(async () => undefined),
    listConnectionCatalog: vi.fn(async () => ({ providers: [] })),
    listConnectionGrants: vi.fn(async () => ({ grants: [] })),
    listGithubInstallations: vi.fn(async () => ({ installations: [] })),
    listGithubRepositories: vi.fn(async () => ({
      source: 'installations' as const,
      repositories: [],
      truncated: false,
    })),
    checkGithubRepositories: vi.fn(async (repos: string[]) => ({
      results: repos.map((repo) => ({ repo, verdict: 'public' as const })),
    })),
    putConnectionGrant: vi.fn(async () => undefined),
    deleteConnectionGrant: vi.fn(async () => undefined),
    listProviderHealth: vi.fn(async () => ({ providers: [] })),
    connectStartUrl: (provider: string) => `/connect/${provider}/start`,
    listCredentialEvents: vi.fn(async () => ({ events: [] })),
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
    ...overrides,
  };
}

describe('usage capture settings', () => {
  function settingsPage(wire: ControlPlaneClient, role: 'admin' | 'member', section: 'usage' | 'profile' = 'usage') {
    const viewer: TenantMe = {
      ...tenantMe,
      membership: { ...tenantMe.membership, role },
    };
    return (
      <SettingsPage
        client={wire}
        viewer={viewer}
        pendingGrantProposals={[]}
        section={section}
        onNavigate={() => undefined}
        onOpenWorkspace={() => undefined}
        onReviewProposal={() => undefined}
        onSignOut={async () => undefined}
        onLeftOrg={() => undefined}
        onSwitchOrg={() => undefined}
        onCreateOrg={() => undefined}
      />
    );
  }

  it('hides the Usage tab and panel from members', async () => {
    const wire = client();
    const view = await render(settingsPage(wire, 'member'));
    await settle();

    expect(view.container.textContent).not.toContain('Usage');
    expect(view.container.textContent).not.toContain('Agent usage capture');
    expect(wire.getUsageCapture).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('shows the state to admins and reflects the enable response', async () => {
    const getUsageCapture = vi.fn(async () => ({ enabled: false, folderId: null }));
    // The first enable lazy-creates the folder server-side; the panel shows
    // whatever the response carries rather than assuming.
    const putUsageCapture = vi.fn(async (enabled: boolean) => ({
      enabled,
      folderId: 'folder-usage',
    }));
    const wire = client({ getUsageCapture, putUsageCapture });
    const view = await render(settingsPage(wire, 'admin'));
    await settle();

    // The switch's accessible name comes from its wrapping label
    // (SettingsSwitch), so the query pins the role instead.
    const toggle = view.container.querySelector<HTMLInputElement>(
      'input[role="switch"]',
    )!;
    expect(toggle.checked).toBe(false);
    expect(view.container.textContent).toContain('created the first time you turn it on');

    await act(async () => {
      toggle.click();
    });
    await settle();
    expect(putUsageCapture).toHaveBeenCalledWith(true);
    expect(view.container.querySelector<HTMLInputElement>(
      'input[role="switch"]',
    )?.checked).toBe(true);
    expect(view.container.querySelector<HTMLAnchorElement>('a[href="/folder/folder-usage"]'))
      .not.toBeNull();
    await view.unmount();
  });

  it('flips usage capture immediately and restores it with an error on rejection', async () => {
    const request = deferred<Awaited<ReturnType<ControlPlaneClient['putUsageCapture']>>>();
    const wire = client({
      getUsageCapture: vi.fn(async () => ({ enabled: false, folderId: null })),
      putUsageCapture: vi.fn(() => request.promise),
    });
    const view = await render(settingsPage(wire, 'admin'));
    await settle();
    const toggle = view.container.querySelector<HTMLInputElement>('input[role="switch"]');
    if (toggle === null) throw new Error('usage switch is missing');

    await act(async () => toggle.click());
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect(view.container.textContent).toContain('Capture is on');

    request.reject(new Error('capture refused'));
    await settle();
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
    expect(view.container.textContent).toContain('Capture is off');
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('capture refused');
    await view.unmount();
  });
});

describe('recipe run flow', () => {
  let deviceStorageValues: Map<string, string>;

  beforeEach(() => {
    window.history.replaceState({}, '', '/recipes');
    deviceStorageValues = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => deviceStorageValues.get(key) ?? null,
        setItem: (key: string, value: string) => deviceStorageValues.set(key, value),
        removeItem: (key: string) => deviceStorageValues.delete(key),
        clear: () => deviceStorageValues.clear(),
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html></html>', {
      headers: { 'content-type': 'text/html' },
    })));
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  // Both addresses are disabled and land on Drive; what still has to work is
  // the strip's create action, which every page carries.
  it.each(['/templates', '/recipes'])(
    'lands on Drive and still opens the create-workspace dialog from %s',
    async (path) => {
      window.history.replaceState({}, '', path);
      const view = await render(
        <CloudApp
          client={client()}
          resolver={standaloneResolver({ files: 7445 })}
        />,
      );
      await settle();
      await settle();

      const createWorkspaceButton = view.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Create workspace"]',
      );
      expect(createWorkspaceButton).not.toBeNull();
      await act(async () => { createWorkspaceButton?.click(); });

      expect(window.location.pathname).toBe(path);
      expect(view.container.querySelector('form[aria-label="Create workspace"]'))
        .not.toBeNull();
      await view.unmount();
    },
  );

});
