import { act } from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createControlPlaneClient } from '../src/api.js';
import { CreateTemplateScreen } from '../src/files/CreateTemplateScreen.js';
import { render, settle } from './dom.js';

afterEach(() => vi.unstubAllGlobals());

const machines = [{
  id: 'cx23@fsn1',
  providerId: 'hetzner',
  supportsVolumes: true,
  name: 'CX23',
  cpuCores: 2,
  memGb: 4,
  diskGb: 40,
  arch: 'x86',
  location: 'fsn1',
}];

const folders = [
  {
    id: 'folder-mine',
    name: 'datasets',
    role: 'owner',
    orgRole: null,
    owner: { name: 'Min Song', avatarUrl: null },
    attachedWorkspaceIds: [],
    createdAt: 1,
    updatedAt: 1,
    grants: [],
  },
  {
    id: 'folder-ada',
    name: 'ada-notes',
    role: 'editor',
    orgRole: 'viewer',
    owner: { name: 'Ada Park', avatarUrl: null },
    attachedWorkspaceIds: [],
    createdAt: 1,
    updatedAt: 1,
  },
];

function stub() {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/machine-types') {
      return Response.json({ machineTypes: machines, failures: [] });
    }
    if (url.pathname === '/folders' && init?.method === undefined) {
      return Response.json({ folders });
    }
    if (url.pathname === '/folders/folder-mine' && init?.method === 'PATCH') {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/workspace-templates' && init?.method === 'POST') {
      return Response.json({ template: {
        id: 'template-1',
        name: 'starter',
        machineTypeId: 'cx23@fsn1',
        createdAt: 2,
        createdBy: { name: 'Min Song', avatarUrl: null },
        folders: [{ id: 'folder-mine', name: 'datasets', role: 'owner' }],
      } }, { status: 201 });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function check(view: { container: HTMLElement }, label: string) {
  const row = [...view.container.querySelectorAll('label.template-pick')]
    .find((candidate) => candidate.textContent?.includes(label));
  expect(row, label).toBeDefined();
  const box = row?.querySelector('input');
  box?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('create template screen', () => {
  it('picks folders, org-shares owned ones, and posts the template', async () => {
    const fetcher = stub();
    const onCreated = vi.fn();
    const view = await render(
      <CreateTemplateScreen
        client={createControlPlaneClient('https://cp.example')}
        orgName="acme"
        onCreated={onCreated}
        onCancel={() => undefined}
      />,
    );
    await settle();

    expect(view.container.textContent).toContain('My Drive');
    expect(view.container.textContent).toContain('Shared with me');
    expect(view.container.textContent).toContain('everyone at acme');

    const name = view.container.querySelector<HTMLInputElement>('input[aria-label="Template name"]')!;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setInputValue === undefined) throw new Error('input value setter unavailable');
    await act(async () => {
      setInputValue.call(name, 'starter');
      name.dispatchEvent(new Event('input', { bubbles: true }));
      check(view, 'datasets');
      check(view, 'ada-notes');
    });
    await settle();
    await act(async () => {
      view.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    // The owned folder without org access gets viewer org sharing; the
    // granted folder is left alone.
    const patches = fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(patches.map(([input]) => new URL(String(input)).pathname)).toEqual(['/folders/folder-mine']);
    expect(patches[0]?.[1]?.body).toBe(JSON.stringify({ orgRole: 'viewer' }));

    const post = fetcher.mock.calls.find(([input, init]) => (
      new URL(String(input)).pathname === '/workspace-templates' && init?.method === 'POST'
    ));
    expect(JSON.parse(String(post?.[1]?.body ?? '{}'))).toEqual({
      name: 'starter',
      machineTypeId: 'cx23@fsn1',
      folderIds: ['folder-mine', 'folder-ada'],
    });
    expect(onCreated).toHaveBeenCalledOnce();
    await view.unmount();
  });
});
