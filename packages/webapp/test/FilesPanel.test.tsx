import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlPlaneClient } from '../src/api.js';
import { FilesPanel } from '../src/settings/FilesPanel.js';
import { render, settle } from './dom.js';

afterEach(() => vi.unstubAllGlobals());

describe('organization files panel', () => {
  it('lists attachable folders and adds the selected folder to a controlled workspace', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/folders') return Response.json({ folders: [{
        id: 'folder-one',
        name: 'Shared Notes',
        role: 'owner',
        createdAt: 1,
        updatedAt: 1,
        grants: [],
      }] });
      if (url.pathname === '/workspaces' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ workspaces: [{
          id: 'workspace-one',
          name: 'Agent Workspace',
          role: 'owner',
        }] });
      }
      if (url.pathname === '/folders/folder-one/objects') {
        return Response.json({ objects: [], cursor: null, truncated: false });
      }
      if (url.pathname === '/members') return Response.json({ members: [] });
      if (url.pathname === '/workspaces/workspace-one/folders' && init?.method === 'POST') {
        return Response.json({ folder: {
          id: 'folder-one',
          name: 'Shared Notes',
          role: 'owner',
          attachedAt: 2,
        } }, { status: 201 });
      }
      if (url.pathname === '/workspaces/workspace-one/folders') {
        return Response.json({ folders: [] });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetcher);
    const view = await render(<FilesPanel client={createControlPlaneClient('https://cp.example')} />);
    await settle();

    const add = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Add folder');
    expect(add).toBeDefined();
    add?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    const request = fetcher.mock.calls.find(([input, init]) => (
      String(input).endsWith('/workspaces/workspace-one/folders')
      && init?.method === 'POST'
    ));
    expect(request?.[1]?.body).toBe(JSON.stringify({ folderId: 'folder-one' }));
    expect(add?.textContent).toBe('Attached');
    expect(view.container.textContent).toContain('periodic tick');
  });

  it('renders an org folder without access as inert metadata', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/folders') return Response.json({ folders: [{
        id: 'private-folder',
        name: 'Private',
        role: null,
        createdAt: 1,
        updatedAt: 2,
      }] });
      if (url.pathname === '/workspaces') return Response.json({ workspaces: [] });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetcher);
    const view = await render(<FilesPanel client={createControlPlaneClient('https://cp.example')} />);
    await settle();

    expect(view.container.textContent).toContain('Private · no access');
    expect(view.container.textContent).toContain('You do not have access');
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('/objects'))).toBe(false);
    expect([...view.container.querySelectorAll('button')].some((button) => (
      button.textContent === 'Add folder' || button.textContent === 'Download'
    ))).toBe(false);
  });
});
