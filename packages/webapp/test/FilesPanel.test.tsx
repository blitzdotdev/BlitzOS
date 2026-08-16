import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlPlaneClient } from '../src/api.js';
import type { TenantMe } from '../src/api-adapter.js';
import { FilesPanel } from '../src/settings/FilesPanel.js';
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

function clickButton(view: { container: HTMLElement }, label: string): HTMLButtonElement {
  const button = [...view.container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent === label
      || candidate.getAttribute('aria-label') === label);
  expect(button, label).toBeDefined();
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return button as HTMLButtonElement;
}

describe('files drive surface', () => {
  it('splits My Drive from Shared with me and attaches through the dialog', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/folders') {
        return Response.json({ folders: [ownedFolder, grantedFolder] });
      }
      if (url.pathname === '/workspaces') {
        return Response.json({ workspaces: [
          { id: 'workspace-one', name: 'brave-otter', role: 'owner', phase: 'ready' },
        ] });
      }
      if (url.pathname === '/workspaces/workspace-one/folders' && init?.method === 'POST') {
        return Response.json({ folder: {
          id: 'folder-mine',
          name: 'shared-notes',
          role: 'owner',
          attachedAt: 2,
        } }, { status: 201 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetcher);
    const view = await render(
      <FilesPanel client={createControlPlaneClient('https://cp.example')} viewer={viewer} />,
    );
    await settle();

    expect(view.container.textContent).toContain('My Drive');
    expect(view.container.textContent).toContain('shared-notes');
    expect(view.container.textContent).not.toContain('ada-datasets');

    clickButton(view, 'Shared with me');
    await settle();
    expect(view.container.textContent).toContain('ada-datasets');
    expect(view.container.querySelector('[title="Ada Park"]')).not.toBeNull();
    expect(view.container.textContent).not.toContain('shared-notes');

    clickButton(view, 'My Drive');
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

  it('hides inaccessible org folders from both locations', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
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
    });
    vi.stubGlobal('fetch', fetcher);
    const view = await render(
      <FilesPanel client={createControlPlaneClient('https://cp.example')} viewer={viewer} />,
    );
    await settle();

    expect(view.container.textContent).not.toContain('private-notes');
    expect(view.container.textContent).toContain('Nothing here yet');
    clickButton(view, 'Shared with me');
    await settle();
    expect(view.container.textContent).not.toContain('private-notes');
    expect(view.container.textContent).toContain('Nothing is shared with you yet');
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('/objects'))).toBe(false);
  });

  it('shows owner attribution and read-only affordances on a shared folder', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
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
      if (url.pathname === '/workspaces') return Response.json({ workspaces: [] });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetcher);
    const view = await render(
      <FilesPanel client={createControlPlaneClient('https://cp.example')} viewer={viewer} />,
    );
    await settle();

    clickButton(view, 'Shared with me');
    await settle();
    clickButton(view, 'Open ada-datasets');
    await settle();
    expect(view.container.textContent).toContain('raw');
    clickButton(view, 'Open raw');
    await settle();
    expect(view.container.textContent).toContain('data.csv');

    clickButton(view, 'More actions for data.csv');
    await settle();
    const remove = [...view.container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.includes('Delete'));
    expect(remove).toBeUndefined();
  });
});
