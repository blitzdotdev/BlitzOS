import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlPlaneClient } from '../src/api.js';
import type { TenantMe } from '../src/api-adapter.js';
import { FilesDrive } from '../src/files/FilesDrive.js';
import { render, settle } from './dom.js';

afterEach(() => vi.unstubAllGlobals());

const viewer: TenantMe = {
  identity: { id: 'user-me', email: 'me@example.com', name: 'Min Song', avatarUrl: null },
  membership: { id: 'membership-me', role: 'member' },
  org: { id: 'org-one', slug: 'acme', name: 'acme', vmLimit: 10 },
  organizations: [],
};

const ownedFolder = {
  id: 'folder-mine',
  name: 'shared-notes',
  role: 'owner',
  owner: { name: 'Min Song', avatarUrl: null },
  attachedWorkspaceIds: [],
  createdAt: 1,
  updatedAt: 1,
  grants: [],
};

const grantedFolder = {
  id: 'folder-ada',
  name: 'ada-datasets',
  role: 'editor',
  owner: { name: 'Ada Park', avatarUrl: null },
  attachedWorkspaceIds: [],
  createdAt: 1,
  updatedAt: 1,
};

function drive(scope: 'mine' | 'shared') {
  return { page: 'drive' as const, scope };
}

function folderRoute(folderId: string, folderPath: string[] = []) {
  return { page: 'folder' as const, folderId, folderPath };
}

function clickButton(view: { container: HTMLElement }, label: string): HTMLButtonElement {
  const button = [...view.container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent === label
      || candidate.getAttribute('aria-label') === label);
  expect(button, label).toBeDefined();
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return button as HTMLButtonElement;
}

function stubFolders(extra?: (url: URL, init?: RequestInit) => Response | null) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const handled = extra?.(url, init);
    if (handled) return handled;
    if (url.pathname === '/folders') {
      return Response.json({ folders: [ownedFolder, grantedFolder] });
    }
    if (url.pathname === '/workspaces') {
      return Response.json({ workspaces: [
        { id: 'workspace-one', name: 'brave-otter', role: 'owner', phase: 'ready' },
      ] });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function props(route: Parameters<typeof FilesDrive>[0]['route']) {
  return {
    client: createControlPlaneClient('https://cp.example'),
    viewer,
    route,
    query: '',
    command: null,
    onNavigate: vi.fn(),
    onUploadTarget: vi.fn(),
  };
}

describe('files drive surface', () => {
  it('splits My Drive from Shared with me by ownership', async () => {
    stubFolders();
    const mine = await render(<FilesDrive {...props(drive('mine'))} />);
    await settle();
    expect(mine.container.textContent).toContain('My Drive');
    expect(mine.container.textContent).toContain('shared-notes');
    expect(mine.container.textContent).not.toContain('ada-datasets');
    await mine.unmount();

    const shared = await render(<FilesDrive {...props(drive('shared'))} />);
    await settle();
    expect(shared.container.textContent).toContain('Shared with me');
    expect(shared.container.textContent).toContain('ada-datasets');
    expect(shared.container.querySelector('[title="Ada Park"]')).not.toBeNull();
    expect(shared.container.textContent).not.toContain('shared-notes');
  });

  it('attaches a folder to a workspace through the dialog', async () => {
    const fetcher = stubFolders((url, init) => {
      if (url.pathname === '/workspaces/workspace-one/folders' && init?.method === 'POST') {
        return Response.json({ folder: {
          id: 'folder-mine',
          name: 'shared-notes',
          role: 'owner',
          guestPath: null,
          attachedAt: 2,
        } }, { status: 201 });
      }
      return null;
    });
    const view = await render(<FilesDrive {...props(drive('mine'))} />);
    await settle();

    clickButton(view, 'More actions for shared-notes');
    await settle();
    clickButton(view, 'Attach to workspace');
    await settle();
    expect(view.container.textContent).toContain('/workspace/shared/shared-notes');
    expect(view.container.textContent).toContain('periodic tick');

    clickButton(view, 'Attach');
    await settle();
    const request = fetcher.mock.calls.find(([input, init]) => (
      String(input).endsWith('/workspaces/workspace-one/folders')
      && init?.method === 'POST'
    ));
    expect(request?.[1]?.body).toBe(JSON.stringify({ folderId: 'folder-mine' }));
    expect(view.container.textContent).toContain('attached');
  });

  it('hides inaccessible folders and shows both empty states', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/folders') {
        return Response.json({ folders: [{
          id: 'private-folder',
          name: 'private-notes',
          role: null,
          owner: { name: 'Dana Whitfield', avatarUrl: null },
          attachedWorkspaceIds: [],
          createdAt: 1,
          updatedAt: 2,
        }] });
      }
      if (url.pathname === '/workspaces') return Response.json({ workspaces: [] });
      return new Response('not found', { status: 404 });
    }));
    const mine = await render(<FilesDrive {...props(drive('mine'))} />);
    await settle();
    expect(mine.container.textContent).not.toContain('private-notes');
    expect(mine.container.textContent).toContain('Nothing here yet');
    await mine.unmount();

    const shared = await render(<FilesDrive {...props(drive('shared'))} />);
    await settle();
    expect(shared.container.textContent).toContain('Nothing is shared with you yet');
  });

  it('browses a shared folder read-only for viewers', async () => {
    stubFolders((url) => {
      if (url.pathname === '/folders') {
        return Response.json({ folders: [{ ...grantedFolder, role: 'viewer' }] });
      }
      if (url.pathname === '/folders/folder-ada/objects') {
        return Response.json({
          objects: [{ key: 'raw/data.csv', size: 2048, mtime: 5, editedBy: 'Ada Park' }],
          cursor: null,
          truncated: false,
        });
      }
      return null;
    });
    const view = await render(
      <FilesDrive {...props(folderRoute('folder-ada', ['raw']))} />,
    );
    await settle();

    expect(view.container.textContent).toContain('data.csv');
    expect(view.container.textContent).toContain('Ada Park');
    clickButton(view, 'More actions for data.csv');
    await settle();
    const remove = [...view.container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.includes('Delete'));
    expect(remove).toBeUndefined();
  });
});
