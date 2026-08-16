import { act } from 'react';
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
  orgRole: null,
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
  orgRole: null,
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
          orgRole: null,
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

interface FakeEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (resolve: (file: File) => void) => void;
  createReader?: () => {
    readEntries: (resolve: (entries: FakeEntry[]) => void) => void;
  };
}

function fakeFileEntry(name: string): FakeEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (resolve) => resolve(new File(['payload'], name)),
  };
}

function fakeDirEntry(name: string, children: FakeEntry[]): FakeEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let drained = false;
      return {
        readEntries: (resolve) => {
          resolve(drained ? [] : children);
          drained = true;
        },
      };
    },
  };
}

function dropEntries(view: { container: HTMLElement }, entries: FakeEntry[], files: File[] = []) {
  const page = view.container.querySelector('.drive-page');
  expect(page).not.toBeNull();
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: ['Files'],
      items: entries.map((entry) => ({ webkitGetAsEntry: () => entry })),
      files,
    },
  });
  page?.dispatchEvent(event);
}

describe('drive sharing', () => {
  it('turns on org-wide access from the share dialog', async () => {
    const fetcher = stubFolders((url, init) => {
      if (url.pathname === '/members') return Response.json({ members: [] });
      if (url.pathname === '/folders/folder-mine' && init?.method === 'PATCH') {
        return new Response(null, { status: 204 });
      }
      return null;
    });
    const view = await render(<FilesDrive {...props(drive('mine'))} />);
    await settle();
    clickButton(view, 'Share shared-notes');
    await settle();
    expect(view.container.textContent).toContain('Everyone at acme');

    const select = view.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Access for everyone at acme"]',
    )!;
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    expect(setSelect).toBeDefined();
    await act(async () => {
      setSelect?.call(select, 'viewer');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    const patch = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patch?.[1]?.body).toBe(JSON.stringify({ orgRole: 'viewer' }));
    await view.unmount();
  });
});

describe('drive drag-and-drop', () => {
  it('uploads dropped files and directories into the open folder at the current path', async () => {
    const fetcher = stubFolders((url, init) => {
      if (url.pathname === '/folders/folder-mine/objects') {
        return Response.json({ objects: [], cursor: null, truncated: false });
      }
      if (init?.method === 'PUT' && url.pathname.startsWith('/folders/folder-mine/objects/')) {
        return new Response(null, { status: 200 });
      }
      return null;
    });
    const view = await render(<FilesDrive {...props(folderRoute('folder-mine', ['docs']))} />);
    await settle();

    dropEntries(view, [
      fakeFileEntry('report.pdf'),
      fakeDirEntry('assets', [fakeFileEntry('logo.svg')]),
    ]);
    await settle();

    const putKeys = fetcher.mock.calls
      .filter(([, init]) => init?.method === 'PUT')
      .map(([input]) => new URL(String(input)).pathname.split('/objects/')[1]);
    expect(putKeys).toEqual(['docs%2Freport.pdf', 'docs%2Fassets%2Flogo.svg']);
    expect(view.container.textContent).toContain('2 files');
    expect(view.container.textContent).toContain('uploaded to shared-notes');
    await view.unmount();
  });

  it('turns a directory dropped on My Drive into a new Drive folder with its contents', async () => {
    const created = {
      id: 'folder-new',
      name: 'field-photos',
      role: 'owner',
      orgRole: null,
      owner: { name: 'Min Song', avatarUrl: null },
      attachedWorkspaceIds: [],
      createdAt: 3,
      updatedAt: 3,
      grants: [],
    };
    const fetcher = stubFolders((url, init) => {
      if (url.pathname === '/folders' && init?.method === 'POST') {
        return Response.json({ folder: created }, { status: 201 });
      }
      if (init?.method === 'PUT' && url.pathname.startsWith('/folders/folder-new/objects/')) {
        return new Response(null, { status: 200 });
      }
      return null;
    });
    const view = await render(<FilesDrive {...props(drive('mine'))} />);
    await settle();

    dropEntries(view, [fakeDirEntry('Field Photos', [
      fakeFileEntry('one.jpg'),
      fakeDirEntry('raw', [fakeFileEntry('two.dng')]),
    ])]);
    await settle();

    const createCall = fetcher.mock.calls.find(([input, init]) => (
      new URL(String(input)).pathname === '/folders' && init?.method === 'POST'
    ));
    expect(createCall?.[1]?.body).toBe(JSON.stringify({ name: 'field-photos' }));
    const putKeys = fetcher.mock.calls
      .filter(([, init]) => init?.method === 'PUT')
      .map(([input]) => new URL(String(input)).pathname.split('/objects/')[1]);
    expect(putKeys).toEqual(['one.jpg', 'raw%2Ftwo.dng']);
    expect(view.container.textContent).toContain('uploaded to field-photos');
    await view.unmount();
  });

  it('refuses drops where nothing can be created or written', async () => {
    const fetcher = stubFolders();
    const shared = await render(<FilesDrive {...props(drive('shared'))} />);
    await settle();
    dropEntries(shared, [fakeDirEntry('anything', [fakeFileEntry('a.txt')])]);
    await settle();
    expect(shared.container.textContent).toContain('Shared with me is read-only');
    await shared.unmount();

    const mine = await render(<FilesDrive {...props(drive('mine'))} />);
    await settle();
    dropEntries(mine, [fakeFileEntry('loose.txt')]);
    await settle();
    expect(mine.container.textContent).toContain('Drop a folder to add it to My Drive');
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST' || init?.method === 'PUT'))
      .toBe(false);
    await mine.unmount();
  });
});
