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
  monthlyPrice: null,
}];

const BUILT_IN_RULES = '# Blitz box — agent rules\n\nManaged by Blitz.\n';

const orgRule = {
  id: 'rule-1',
  name: 'House rules',
  content: '# House rules\n',
  updatedAt: 3,
  builtIn: false,
};

const builtInRule = {
  id: null,
  name: 'Default (built-in)',
  content: BUILT_IN_RULES,
  updatedAt: null,
  builtIn: true,
};

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

function stub(extra?: (url: URL, init?: RequestInit) => Response | null) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const handled = extra?.(url, init);
    if (handled) return handled;
    if (url.pathname === '/machine-types') {
      return Response.json({ machineTypes: machines, failures: [] });
    }
    if (url.pathname === '/agent-rules' && init?.method === undefined) {
      return Response.json({ rules: [builtInRule, orgRule] });
    }
    if (url.pathname === '/folders' && init?.method === undefined) {
      return Response.json({ folders });
    }
    if (url.pathname === '/folders/folder-ada/objects') {
      return Response.json({
        objects: [
          { key: 'raw/data.csv', size: 2048, mtime: 5, editedBy: 'Ada Park' },
          { key: 'report.md', size: 128, mtime: 6, editedBy: 'Ada Park' },
        ],
        cursor: null,
        truncated: false,
      });
    }
    if (url.pathname === '/folders/folder-mine' && init?.method === 'PATCH') {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/connections/github/repositories') {
      return Response.json({ error: 'connect github', retryAction: null }, { status: 409 });
    }
    if (url.pathname === '/workspace-templates' && init?.method === 'POST') {
      return Response.json({ template: {
        id: 'template-1',
        name: 'starter',
        machineTypeId: 'cx23@fsn1',
        createdAt: 2,
        createdBy: { name: 'Min Song', avatarUrl: null },
        environment: null,
        agentRuleId: null,
        folders: [{ id: 'folder-mine', name: 'datasets', role: 'owner' }],
      } }, { status: 201 });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function row(view: { container: HTMLElement }, label: string): HTMLElement {
  const found = [...view.container.querySelectorAll<HTMLElement>('.tplf-row')]
    .find((candidate) => candidate.textContent?.includes(label));
  expect(found, label).toBeDefined();
  return found!;
}

function uploadButton(view: { container: HTMLElement }): HTMLButtonElement {
  const found = view.container.querySelector<HTMLButtonElement>('.tplf-upload');
  expect(found).not.toBeNull();
  return found!;
}

function uploadMenuItem(view: { container: HTMLElement }, label: string): HTMLButtonElement {
  const found = [...view.container.querySelectorAll<HTMLButtonElement>('.tplf-upload-menu .drive-menu-item')]
    .find((candidate) => candidate.textContent === label);
  expect(found, label).toBeDefined();
  return found!;
}

async function screenWith(fetcher = stub()) {
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
  return { view, onCreated, fetcher };
}

describe('create template screen', () => {
  it('attaches on row click, detaches on a second click, and posts the template', async () => {
    const fetcher = stub();
    const { view, onCreated } = await screenWith(fetcher);

    // One merged list, Google-Drive-style rows with owner attribution.
    expect(view.container.textContent).not.toContain('Shared with me');
    expect(view.container.querySelector<HTMLDetailsElement>('.blueprint-advanced')?.open).toBe(false);
    expect(row(view, 'datasets').textContent).toContain('me');
    expect(row(view, 'ada-notes').textContent).toContain('Ada Park');
    // The footer carries exactly one button, and it is the upload control.
    expect([...view.container.querySelectorAll('.tplf-foot button')]).toHaveLength(1);
    expect(uploadButton(view).textContent).toBe('Upload');

    await act(async () => {
      row(view, 'datasets').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.container.querySelector('.tplf-side')?.textContent).toContain('datasets');
    expect(row(view, 'datasets').textContent).toContain('In template');
    expect(row(view, 'datasets').getAttribute('aria-pressed')).toBe('true');

    // Clicking the same row again takes it back out.
    await act(async () => {
      row(view, 'datasets').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.container.querySelector('.tplf-foot-hint')?.textContent).toBe('Nothing attached');
    expect(row(view, 'datasets').getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      row(view, 'datasets').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      row(view, 'ada-notes').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.container.querySelector('.tplf-foot-hint')?.textContent).toBe('2 attachments');

    const name = view.container.querySelector<HTMLInputElement>('input[aria-label="Template name"]')!;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setInputValue === undefined) throw new Error('input value setter unavailable');
    await act(async () => {
      setInputValue.call(name, 'starter');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
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
      connections: [],
      repos: [],
    });
    expect(onCreated).toHaveBeenCalledOnce();
    await view.unmount();
  });

  it('prefills edit mode from the template and saves through PUT', async () => {
    const fetcher = stub((url, init) => {
      if (url.pathname === '/workspace-templates' && init?.method === undefined) {
        return Response.json({ templates: [{
          id: 'template-1',
          name: 'starter',
          machineTypeId: 'cx23@fsn1',
          createdAt: 2,
          createdBy: { name: 'Min Song', avatarUrl: null },
          isOrgDefault: false,
          folders: [
            { id: 'folder-mine', name: 'datasets', role: 'owner' },
            { id: 'folder-gone', name: 'lost-notes', role: null },
          ],
          connections: [],
          repos: [],
        }] });
      }
      if (url.pathname === '/workspace-templates/template-1' && init?.method === 'PUT') {
        return Response.json({ template: {
          id: 'template-1',
          name: 'starter v2',
          machineTypeId: 'cx23@fsn1',
          createdAt: 2,
          createdBy: { name: 'Min Song', avatarUrl: null },
          folders: [{ id: 'folder-mine', name: 'datasets', role: 'owner' }],
        } });
      }
      return null;
    });
    const onCreated = vi.fn();
    const view = await render(
      <CreateTemplateScreen
        client={createControlPlaneClient('https://cp.example')}
        orgName="acme"
        editTemplateId="template-1"
        onCreated={onCreated}
        onCancel={() => undefined}
      />,
    );
    await settle();

    expect(view.container.textContent).toContain('Edit workspace template');
    const name = view.container.querySelector<HTMLInputElement>('input[aria-label="Template name"]')!;
    expect(name.value).toBe('starter');
    expect(row(view, 'datasets').textContent).toContain('In template');

    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setInputValue === undefined) throw new Error('input value setter unavailable');
    await act(async () => {
      setInputValue.call(name, 'starter v2');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    const put = fetcher.mock.calls.find(([input, init]) => (
      new URL(String(input)).pathname === '/workspace-templates/template-1' && init?.method === 'PUT'
    ));
    // The unreadable folder id survives the round trip untouched.
    expect(JSON.parse(String(put?.[1]?.body ?? '{}'))).toEqual({
      // The edit form always submits the full create shape, environment
      // included, so clearing it in the editor actually clears it.
      environment: { env: {}, startupScript: null },
      name: 'starter v2',
      machineTypeId: 'cx23@fsn1',
      folderIds: ['folder-mine', 'folder-gone'],
      connections: [],
      repos: [],
    });
    expect(onCreated).toHaveBeenCalledOnce();
    await view.unmount();
  });

  it('prefills a stored environment on edit and round-trips it through PUT', async () => {
    const stored = { env: { PROJECT_MODE: 'analysis' }, startupScript: './setup.sh\n' };
    const fetcher = stub((url, init) => {
      if (url.pathname === '/workspace-templates' && init?.method === undefined) {
        return Response.json({ templates: [{
          id: 'template-1',
          name: 'starter',
          machineTypeId: 'cx23@fsn1',
          createdAt: 2,
          createdBy: { name: 'Min Song', avatarUrl: null },
          environment: stored,
          isOrgDefault: false,
          connections: [],
          folders: [{ id: 'folder-mine', name: 'datasets', role: 'owner' }],
          repos: [],
        }] });
      }
      if (url.pathname === '/workspace-templates/template-1' && init?.method === 'PUT') {
        return Response.json({ template: {
          id: 'template-1',
          name: 'starter',
          machineTypeId: 'cx23@fsn1',
          createdAt: 2,
          createdBy: { name: 'Min Song', avatarUrl: null },
          environment: stored,
          connections: [],
          folders: [{ id: 'folder-mine', name: 'datasets', role: 'owner' }],
        } });
      }
      return null;
    });
    const view = await render(
      <CreateTemplateScreen
        client={createControlPlaneClient('https://cp.example')}
        orgName="acme"
        editTemplateId="template-1"
        onCreated={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await settle();

    // The editor is no longer hidden on edit, and it shows what is stored.
    expect(view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Environment variable key 1"]',
    )?.value).toBe('PROJECT_MODE');
    expect(view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Environment variable value 1"]',
    )?.value).toBe('analysis');
    expect(view.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Startup script"]',
    )?.value).toBe('./setup.sh\n');

    // Saving without touching Advanced resubmits it rather than wiping it.
    await act(async () => {
      view.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    const put = fetcher.mock.calls.find(([input, init]) => (
      new URL(String(input)).pathname === '/workspace-templates/template-1' && init?.method === 'PUT'
    ));
    expect(JSON.parse(String(put?.[1]?.body ?? '{}')).environment).toEqual(stored);
    await view.unmount();
  });

  it('posts a populated advanced environment', async () => {
    const fetcher = stub();
    const { view } = await screenWith(fetcher);
    const name = view.container.querySelector<HTMLInputElement>('input[aria-label="Template name"]')!;
    const key = view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Environment variable key 1"]',
    )!;
    const value = view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Environment variable value 1"]',
    )!;
    const script = view.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Startup script"]',
    )!;
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const textareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (inputSetter === undefined || textareaSetter === undefined) throw new Error('input setter unavailable');
    await act(async () => {
      inputSetter.call(name, 'starter');
      name.dispatchEvent(new Event('input', { bubbles: true }));
      inputSetter.call(key, 'PROJECT_MODE');
      key.dispatchEvent(new Event('input', { bubbles: true }));
      inputSetter.call(value, 'analysis');
      value.dispatchEvent(new Event('input', { bubbles: true }));
      textareaSetter.call(script, './setup.sh\n');
      script.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    const post = fetcher.mock.calls.find(([input, init]) => (
      new URL(String(input)).pathname === '/workspace-templates' && init?.method === 'POST'
    ));
    expect(JSON.parse(String(post?.[1]?.body ?? '{}'))).toEqual({
      name: 'starter',
      machineTypeId: 'cx23@fsn1',
      folderIds: [],
      connections: [],
      repos: [],
      environment: {
        env: { PROJECT_MODE: 'analysis' },
        startupScript: './setup.sh\n',
      },
    });
    await view.unmount();
  });


  it('offers the org rule library in the same Advanced section and posts the pick', async () => {
    const fetcher = stub();
    const { view } = await screenWith(fetcher);

    // One collapsed Advanced section holds both editors, not two.
    const advanced = view.container.querySelectorAll<HTMLDetailsElement>('.blueprint-advanced');
    expect(advanced).toHaveLength(1);
    expect(advanced[0]?.open).toBe(false);
    expect(advanced[0]?.querySelector('textarea[aria-label="Startup script"]')).not.toBeNull();

    const select = view.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Agent rules document"]',
    )!;
    expect(advanced[0]?.contains(select)).toBe(true);
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Default (built-in)',
      'House rules',
      'New rule…',
    ]);
    expect(select.value).toBe('');

    const name = view.container.querySelector<HTMLInputElement>('input[aria-label="Template name"]')!;
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (inputSetter === undefined || selectSetter === undefined) throw new Error('setter unavailable');
    await act(async () => {
      inputSetter.call(name, 'starter');
      name.dispatchEvent(new Event('input', { bubbles: true }));
      selectSetter.call(select, 'rule-1');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    const post = fetcher.mock.calls.find(([input, init]) => (
      new URL(String(input)).pathname === '/workspace-templates' && init?.method === 'POST'
    ));
    expect(JSON.parse(String(post?.[1]?.body ?? '{}'))).toEqual({
      name: 'starter',
      machineTypeId: 'cx23@fsn1',
      folderIds: [],
      connections: [],
      repos: [],
      agentRuleId: 'rule-1',
    });
    await view.unmount();
  });

  it('copies the built-in doc on edit instead of changing it in place', async () => {
    const fetcher = stub((url, init) => {
      if (url.pathname.startsWith('/agent-rules/') && init?.method === 'PUT') {
        const id = url.pathname.slice('/agent-rules/'.length);
        // SAFETY: The screen always sends a JSON body on this route.
        const body = JSON.parse(String(init.body)) as { name: string; content: string };
        return Response.json({
          rule: { id, ...body, updatedAt: 9, builtIn: false },
        }, { status: 201 });
      }
      return null;
    });
    const { view } = await screenWith(fetcher);
    const edit = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.className === 'blueprint-agent-rules-edit')!;
    await act(async () => { edit.click(); });

    const dialog = view.container.querySelector('.blueprint-agent-rules-dialog')!;
    expect(dialog.textContent).toContain('The built-in default is never changed in place');
    const content = view.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Agent rules content"]',
    )!;
    // Copy-on-write: the built-in bytes are the starting point, the name is not.
    expect(content.value).toBe(BUILT_IN_RULES);
    const ruleName = view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Agent rules name"]',
    )!;
    expect(ruleName.value).toBe('');
    // Editing the built-in cannot delete it.
    expect(view.container.querySelector('.blueprint-agent-rules-delete')).toBeNull();

    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const textareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (inputSetter === undefined || textareaSetter === undefined) throw new Error('setter unavailable');
    await act(async () => {
      inputSetter.call(ruleName, 'Ours');
      ruleName.dispatchEvent(new Event('input', { bubbles: true }));
      textareaSetter.call(content, `${BUILT_IN_RULES}\nAlways run the tests.\n`);
      content.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Save rules')!;
    await act(async () => { save.click(); });
    await settle();

    const put = fetcher.mock.calls.find(([input, init]) => (
      new URL(String(input)).pathname.startsWith('/agent-rules/') && init?.method === 'PUT'
    ));
    expect(put).toBeDefined();
    const putId = new URL(String(put?.[0])).pathname.slice('/agent-rules/'.length);
    expect(putId).not.toBe('');
    expect(JSON.parse(String(put?.[1]?.body ?? '{}'))).toEqual({
      name: 'Ours',
      content: `${BUILT_IN_RULES}\nAlways run the tests.\n`,
    });
    // The saved copy is selected, and the editor closes.
    expect(view.container.querySelector('.blueprint-agent-rules-dialog')).toBeNull();
    expect(view.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Agent rules document"]',
    )?.value).toBe(putId);
    await view.unmount();
  });

  // The rules editor used to hand-roll its backdrop and shipped without either
  // behaviour the shared confirmation dialog already had.
  it('closes the rules editor on Escape and returns focus to the opener', async () => {
    const { view } = await screenWith();
    const edit = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.className === 'blueprint-agent-rules-edit')!;
    await act(async () => {
      edit.focus();
      edit.click();
    });
    expect(view.container.querySelector('.blueprint-agent-rules-dialog')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(view.container.querySelector('.blueprint-agent-rules-dialog')).toBeNull();
    expect(document.activeElement).toBe(edit);
    await view.unmount();
  });

  it('warns that deleting a rule drops its holders back to the default', async () => {
    const deleted: string[] = [];
    const fetcher = stub((url, init) => {
      if (url.pathname.startsWith('/agent-rules/') && init?.method === 'DELETE') {
        deleted.push(url.pathname.slice('/agent-rules/'.length));
        return new Response(null, { status: 204 });
      }
      return null;
    });
    const { view } = await screenWith(fetcher);
    const select = view.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Agent rules document"]',
    )!;
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (selectSetter === undefined) throw new Error('setter unavailable');
    await act(async () => {
      selectSetter.call(select, 'rule-1');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const edit = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.className === 'blueprint-agent-rules-edit')!;
    await act(async () => { edit.click(); });
    expect(view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Agent rules name"]',
    )?.value).toBe('House rules');

    // Delete asks through the shared confirmation dialog, which the app already
    // uses everywhere else — so this step gets Escape and focus restore for
    // free instead of the bespoke two-click toggle it used to have.
    const remove = view.container.querySelector<HTMLButtonElement>('.blueprint-agent-rules-delete')!;
    await act(async () => { remove.click(); });
    const confirmation = view.container.querySelector('.webapp-confirmation-dialog');
    expect(confirmation?.textContent)
      .toContain('Templates and workspaces that use it fall back to Default (built-in)');
    expect(deleted).toEqual([]);

    // Escape backs out of the confirmation without deleting anything.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(view.container.querySelector('.webapp-confirmation-dialog')).toBeNull();
    expect(deleted).toEqual([]);

    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('.blueprint-agent-rules-delete')?.click();
    });
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('.webapp-confirmation-confirm')?.click();
    });
    await settle();
    expect(deleted).toEqual(['rule-1']);
    expect(view.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Agent rules document"]',
    )?.value).toBe('');
    await view.unmount();
  });

  it('enters a folder on double click, walks back up, and keeps what is attached', async () => {
    const { view } = await screenWith();
    const back = view.container.querySelector<HTMLButtonElement>('.tplf-back')!;
    expect(back.disabled).toBe(true);

    await act(async () => {
      row(view, 'datasets').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.container.querySelector('.tplf-foot-hint')?.textContent).toBe('1 attachment');

    await act(async () => {
      row(view, 'ada-notes').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await settle();
    expect(view.container.querySelector('.tplf-crumb')?.textContent).toBe('ada-notes');
    expect(row(view, 'raw').textContent).toContain('1 file');
    expect(row(view, 'report.md').textContent).toContain('128 B');
    // Looking inside a folder changes nothing about what is attached.
    expect(view.container.querySelector('.tplf-foot-hint')?.textContent).toBe('1 attachment');

    await act(async () => {
      row(view, 'raw').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(view.container.querySelector('.tplf-crumb')?.textContent).toBe('ada-notes / raw');
    expect(row(view, 'data.csv')).toBeDefined();

    await act(async () => {
      back.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.container.querySelector('.tplf-crumb')?.textContent).toBe('ada-notes');
    await act(async () => {
      back.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.container.querySelector('.tplf-crumb')?.textContent).toBe('All folders');
    await view.unmount();
  });

  it('attaches a single Drive file by copying it into the template files folder', async () => {
    const filesFolder = {
      id: 'folder-files',
      name: 'new-template-files',
      role: 'owner',
      orgRole: null,
      owner: { name: 'Min Song', avatarUrl: null },
      attachedWorkspaceIds: [],
      createdAt: 4,
      updatedAt: 4,
      grants: [],
    };
    let created = false;
    const puts: string[] = [];
    const deletes: string[] = [];
    const fetcher = stub((url, init) => {
      if (url.pathname === '/folders' && init?.method === 'POST') {
        created = true;
        return Response.json({ folder: filesFolder }, { status: 201 });
      }
      if (url.pathname === '/folders' && init?.method === undefined && created) {
        return Response.json({ folders: [...folders, filesFolder] });
      }
      if (url.pathname === '/folders/folder-ada/objects/report.md' && init?.method === undefined) {
        return new Response('# report\n');
      }
      if (url.pathname === '/folders/folder-files/objects/report.md') {
        if (init?.method === 'PUT') { puts.push(url.pathname); return new Response(null, { status: 200 }); }
        if (init?.method === 'DELETE') { deletes.push(url.pathname); return new Response(null, { status: 204 }); }
      }
      return null;
    });
    const { view } = await screenWith(fetcher);

    await act(async () => {
      row(view, 'ada-notes').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await settle();

    // A file is a first-class attachment: clicking it copies the bytes into
    // the template's own files folder, which is what gets attached.
    await act(async () => {
      row(view, 'report.md').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(puts).toEqual(['/folders/folder-files/objects/report.md']);
    expect(row(view, 'report.md').getAttribute('aria-pressed')).toBe('true');
    expect(row(view, 'report.md').textContent).toContain('In template');
    expect(view.container.querySelector('.tplf-side')?.textContent).toContain('new-template-files');

    // Clicking again removes the copy.
    await act(async () => {
      row(view, 'report.md').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(deletes).toEqual(['/folders/folder-files/objects/report.md']);
    expect(row(view, 'report.md').getAttribute('aria-pressed')).toBe('false');
    await view.unmount();
  });

  it('shows the org-default checkbox only to admins and posts the tick', async () => {
    // Members never see the control, and their POST carries no isOrgDefault
    // key at all — the exact-body pins in the tests above already prove the
    // absence for the default (non-admin) render.
    const memberView = await render(
      <CreateTemplateScreen
        client={createControlPlaneClient('https://cp.example')}
        orgName="acme"
        onCreated={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await settle();
    expect(memberView.container.querySelector(
      'input[aria-label="Default template for acme"]',
    )).toBeNull();
    await memberView.unmount();

    const fetcher = stub();
    const onCreated = vi.fn();
    const view = await render(
      <CreateTemplateScreen
        client={createControlPlaneClient('https://cp.example')}
        orgName="acme"
        isAdmin
        onCreated={onCreated}
        onCancel={() => undefined}
      />,
    );
    await settle();
    const checkbox = view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Default template for acme"]',
    )!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(false);
    await act(async () => { checkbox.click(); });

    const name = view.container.querySelector<HTMLInputElement>('input[aria-label="Template name"]')!;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setInputValue === undefined) throw new Error('input value setter unavailable');
    await act(async () => {
      setInputValue.call(name, 'starter');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    const post = fetcher.mock.calls.find(([input, init]) => (
      new URL(String(input)).pathname === '/workspace-templates' && init?.method === 'POST'
    ));
    expect(JSON.parse(String(post?.[1]?.body ?? '{}'))).toEqual({
      name: 'starter',
      machineTypeId: 'cx23@fsn1',
      folderIds: [],
      connections: [],
      repos: [],
      isOrgDefault: true,
    });
    expect(onCreated).toHaveBeenCalledOnce();
    await view.unmount();
  });

  it('loads the org-default tick from the template on edit', async () => {
    stub((url, init) => {
      if (url.pathname === '/workspace-templates' && init?.method === undefined) {
        return Response.json({ templates: [{
          id: 'template-1',
          name: 'starter',
          machineTypeId: 'cx23@fsn1',
          createdAt: 2,
          createdBy: { name: 'Min Song', avatarUrl: null },
          isOrgDefault: true,
          folders: [],
          connections: [],
          repos: [],
        }] });
      }
      return null;
    });
    const view = await render(
      <CreateTemplateScreen
        client={createControlPlaneClient('https://cp.example')}
        orgName="acme"
        editTemplateId="template-1"
        isAdmin
        onCreated={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await settle();
    expect(view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Default template for acme"]',
    )?.checked).toBe(true);
    await view.unmount();
  });

  it('hints at the github connection until it is configured, then offers repos', async () => {
    // The stub's default 409 is the unconfigured state; screenWith renders a
    // member, so the hint routes them to their admin, not to a form.
    const unconfigured = await screenWith();
    expect(unconfigured.view.container.textContent)
      .toContain('Ask an admin to set up GitHub above');
    expect(unconfigured.view.container.querySelector(
      'input[aria-label="Filter repositories"]',
    )).toBeNull();
    await unconfigured.view.unmount();

    const fetcher = stub((url) => {
      if (url.pathname === '/connections/github/repositories') {
        return Response.json({ repositories: [
          { fullName: 'acme/app', private: false },
          { fullName: 'acme/tools', private: true },
          { fullName: 'other/sdk', private: false },
        ] });
      }
      return null;
    });
    const { view } = await screenWith(fetcher);
    expect(view.container.textContent)
      .not.toContain('Ask an admin to add the GitHub key');

    // The filter narrows without losing the selection UI.
    const filter = view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter repositories"]',
    )!;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setInputValue === undefined) throw new Error('input value setter unavailable');
    await act(async () => {
      setInputValue.call(filter, 'acme');
      filter.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const labels = [...view.container.querySelectorAll('.tplf-repo')];
    expect(labels.map((label) => label.textContent)).toEqual(['acme/app', 'acme/toolsprivate']);

    const appToggle = labels[0]?.querySelector<HTMLInputElement>('input')!;
    await act(async () => { appToggle.click(); });
    expect(view.container.textContent).toContain('1 repository selected');

    const name = view.container.querySelector<HTMLInputElement>('input[aria-label="Template name"]')!;
    await act(async () => {
      setInputValue.call(name, 'repo starter');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    const post = fetcher.mock.calls.find(([input, init]) => (
      new URL(String(input)).pathname === '/workspace-templates' && init?.method === 'POST'
    ));
    expect(JSON.parse(String(post?.[1]?.body ?? '{}')).repos).toEqual(['acme/app']);
    await view.unmount();
  });

  it('shows a picker selection as attached and removes it immediately when unchecked', async () => {
    const fetcher = stub((url) => {
      if (url.pathname === '/connections/github/repositories') {
        return Response.json({ repositories: [{ fullName: 'acme/app', private: false }] });
      }
      return null;
    });
    const { view } = await screenWith(fetcher);
    const toggle = view.container.querySelector<HTMLInputElement>('.tplf-repo input')!;

    await act(async () => { toggle.click(); });

    expect(view.container.querySelector('.tplf-attached-label')?.textContent).toBe('Attached');
    expect(view.container.querySelector('.tplf-attached-row')?.textContent).toBe('acme/appRemove');
    expect(view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove acme/app"]',
    )?.textContent).toBe('Remove');

    await act(async () => { toggle.click(); });

    expect(view.container.querySelector('.tplf-attached-row')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Remove acme/app"]')).toBeNull();
    await view.unmount();
  });

  it('reports a malformed public repo URL without checking it', async () => {
    const fetcher = stub((url) => {
      if (url.pathname === '/connections/github/repositories') {
        return Response.json({ repositories: [] });
      }
      return null;
    });
    const { view } = await screenWith(fetcher);
    const textarea = view.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Public repository URLs"]',
    )!;
    const setTextareaValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    if (setTextareaValue === undefined) throw new Error('textarea value setter unavailable');
    await act(async () => {
      setTextareaValue.call(textarea, 'https://gitlab.com/acme/app');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('.tplf-repo-urls-add')?.click();
    });

    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'https://gitlab.com/acme/app — only github.com repositories can be cloned',
    );
    expect(fetcher.mock.calls.some(([input]) => (
      new URL(String(input)).pathname === '/connections/github/repositories/check'
    ))).toBe(false);
    await view.unmount();
  });

  it('adds a public repo batch only after every repo is reachable and saves it through PUT', async () => {
    const fetcher = stub((url, init) => {
      if (url.pathname === '/connections/github/repositories') {
        return Response.json({ repositories: [] });
      }
      if (url.pathname === '/connections/github/repositories/check' && init?.method === 'POST') {
        if (String(init.body).includes('acme/private')) {
          return Response.json({ results: [
            { repo: 'acme/one', reachable: true },
            { repo: 'acme/private', reachable: false, failure: 'not-public' },
          ] });
        }
        return Response.json({ results: [
          { repo: 'acme/one', reachable: true },
          { repo: 'acme/two', reachable: true },
        ] });
      }
      if (url.pathname === '/workspace-templates' && init?.method === undefined) {
        return Response.json({ templates: [{
          id: 'template-1',
          name: 'starter',
          machineTypeId: 'cx23@fsn1',
          createdAt: 2,
          createdBy: { name: 'Min Song', avatarUrl: null },
          isOrgDefault: false,
          folders: [],
          connections: [],
          repos: [],
        }] });
      }
      if (url.pathname === '/workspace-templates/template-1' && init?.method === 'PUT') {
        return Response.json({ template: {
          id: 'template-1',
          name: 'starter',
          machineTypeId: 'cx23@fsn1',
          createdAt: 2,
          createdBy: { name: 'Min Song', avatarUrl: null },
          folders: [],
          connections: [],
          repos: ['acme/one', 'acme/two'],
        } });
      }
      return null;
    });
    const view = await render(
      <CreateTemplateScreen
        client={createControlPlaneClient('https://cp.example')}
        orgName="acme"
        editTemplateId="template-1"
        onCreated={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await settle();
    const textarea = view.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Public repository URLs"]',
    )!;
    const setTextareaValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    if (setTextareaValue === undefined) throw new Error('textarea value setter unavailable');

    await act(async () => {
      setTextareaValue.call(textarea, [
        'https://github.com/acme/one',
        'https://github.com/acme/private',
      ].join('\n'));
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('.tplf-repo-urls-add')?.click();
    });
    await settle();

    expect(view.container.querySelector('[role="alert"]')?.textContent)
      .toContain('acme/private — not found, or it is private');
    expect(view.container.querySelectorAll('.tplf-attached-row')).toHaveLength(0);

    await act(async () => {
      setTextareaValue.call(textarea, [
        'https://github.com/acme/one',
        'https://github.com/acme/two',
      ].join('\n'));
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('.tplf-repo-urls-add')?.click();
    });
    await settle();

    expect([...view.container.querySelectorAll('.tplf-attached-row')]
      .map((repo) => repo.textContent)).toEqual(['acme/oneRemove', 'acme/twoRemove']);
    expect([...view.container.querySelectorAll('.tplf-attached-row button')]
      .map((button) => button.getAttribute('aria-label'))).toEqual([
      'Remove acme/one',
      'Remove acme/two',
    ]);
    await act(async () => {
      view.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    const checks = fetcher.mock.calls.filter(([input, init]) => (
      new URL(String(input)).pathname === '/connections/github/repositories/check'
      && init?.method === 'POST'
    ));
    expect(checks.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { repos: ['acme/one', 'acme/private'] },
      { repos: ['acme/one', 'acme/two'] },
    ]);
    const put = fetcher.mock.calls.find(([input, init]) => (
      new URL(String(input)).pathname === '/workspace-templates/template-1' && init?.method === 'PUT'
    ));
    expect(JSON.parse(String(put?.[1]?.body ?? '{}')).repos).toEqual(['acme/one', 'acme/two']);
    await view.unmount();
  });

  it('reports a picker-selected repo as already added', async () => {
    const fetcher = stub((url) => {
      if (url.pathname === '/connections/github/repositories') {
        return Response.json({ repositories: [{ fullName: 'acme/app', private: false }] });
      }
      return null;
    });
    const { view } = await screenWith(fetcher);
    await act(async () => {
      view.container.querySelector<HTMLInputElement>('.tplf-repo input')?.click();
    });
    const textarea = view.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Public repository URLs"]',
    )!;
    const setTextareaValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    if (setTextareaValue === undefined) throw new Error('textarea value setter unavailable');
    await act(async () => {
      setTextareaValue.call(textarea, 'https://github.com/acme/app');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('.tplf-repo-urls-add')?.click();
    });

    expect(view.container.querySelector('[role="alert"]')?.textContent)
      .toContain('https://github.com/acme/app — already added');
    expect(fetcher.mock.calls.some(([input]) => (
      new URL(String(input)).pathname === '/connections/github/repositories/check'
    ))).toBe(false);
    await view.unmount();
  });

  it('adds, shows, and submits a public repo when GitHub is unconfigured', async () => {
    const fetcher = stub((url, init) => {
      if (url.pathname === '/connections/github/repositories/check' && init?.method === 'POST') {
        return Response.json({ results: [{ repo: 'public/example', reachable: true }] });
      }
      return null;
    });
    const { view } = await screenWith(fetcher);
    expect(view.container.textContent).toContain('Ask an admin to set up GitHub above');
    const textarea = view.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Public repository URLs"]',
    )!;
    const setTextareaValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    if (setTextareaValue === undefined) throw new Error('textarea value setter unavailable');
    await act(async () => {
      setTextareaValue.call(textarea, 'https://github.com/public/example');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('.tplf-repo-urls-add')?.click();
    });
    await settle();

    expect(view.container.querySelector('.tplf-attached-row')?.textContent).toBe('public/exampleRemove');
    expect(view.container.querySelector('button[aria-label="Remove public/example"]')?.textContent)
      .toBe('Remove');
    const name = view.container.querySelector<HTMLInputElement>('input[aria-label="Template name"]')!;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setInputValue === undefined) throw new Error('input value setter unavailable');
    await act(async () => {
      setInputValue.call(name, 'public starter');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    const post = fetcher.mock.calls.find(([input, init]) => (
      new URL(String(input)).pathname === '/workspace-templates' && init?.method === 'POST'
    ));
    expect(JSON.parse(String(post?.[1]?.body ?? '{}')).repos).toEqual(['public/example']);
    await view.unmount();
  });

  it('warns at the 16-repo cap and disables further picks', async () => {
    const selected = Array.from({ length: 16 }, (_, i) => `acme/repo-${i}`);
    stub((url, init) => {
      if (url.pathname === '/connections/github/repositories') {
        return Response.json({ repositories: [
          ...selected.map((fullName) => ({ fullName, private: false })),
          { fullName: 'acme/one-more', private: false },
        ] });
      }
      if (url.pathname === '/workspace-templates' && init?.method === undefined) {
        return Response.json({ templates: [{
          id: 'template-1',
          name: 'starter',
          machineTypeId: 'cx23@fsn1',
          createdAt: 2,
          createdBy: { name: 'Min Song', avatarUrl: null },
          isOrgDefault: false,
          folders: [],
          connections: [{ provider: 'github' }],
          repos: selected,
        }] });
      }
      return null;
    });
    const view = await render(
      <CreateTemplateScreen
        client={createControlPlaneClient('https://cp.example')}
        orgName="acme"
        editTemplateId="template-1"
        onCreated={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await settle();

    expect(view.container.textContent).toContain('Up to 16 repositories per template');
    const oneMore = [...view.container.querySelectorAll('.tplf-repo')]
      .find((label) => label.textContent?.includes('acme/one-more'))
      ?.querySelector<HTMLInputElement>('input');
    expect(oneMore?.disabled).toBe(true);
    // Selected ones stay removable.
    const first = [...view.container.querySelectorAll('.tplf-repo')]
      .find((label) => label.textContent?.includes('acme/repo-0'))
      ?.querySelector<HTMLInputElement>('input');
    expect(first?.disabled).toBe(false);
    await view.unmount();
  });

  it('wraps dropped loose files into an auto-created files folder', async () => {
    const filesFolder = {
      id: 'folder-files',
      name: 'starter-files',
      role: 'owner',
      orgRole: null,
      owner: { name: 'Min Song', avatarUrl: null },
      attachedWorkspaceIds: [],
      createdAt: 4,
      updatedAt: 4,
      grants: [],
    };
    const folderPosts: string[] = [];
    const fetcher = stub((url, init) => {
      if (url.pathname === '/folders' && init?.method === 'POST') {
        folderPosts.push(String(JSON.parse(String(init.body)).name));
        return Response.json({ folder: filesFolder }, { status: 201 });
      }
      if (url.pathname === '/folders' && init?.method === undefined && folderPosts.length > 0) {
        return Response.json({ folders: [...folders, filesFolder] });
      }
      if (init?.method === 'PUT' && url.pathname.startsWith('/folders/folder-files/objects/')) {
        return new Response(null, { status: 200 });
      }
      return null;
    });
    const { view } = await screenWith(fetcher);

    // The template name at drop time names the folder.
    const name = view.container.querySelector<HTMLInputElement>('input[aria-label="Template name"]')!;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setInputValue === undefined) throw new Error('input value setter unavailable');
    await act(async () => {
      setInputValue.call(name, 'starter');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const pane = view.container.querySelector('.tplf-main')!;
    const fileEntry = (fileName: string) => ({
      isFile: true,
      isDirectory: false,
      name: fileName,
      file: (accept: (file: File) => void) => accept(new File(['x'], fileName)),
    });
    const drop = (entries: unknown[]) => {
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: {
          types: ['Files'],
          items: entries.map((entry) => ({ webkitGetAsEntry: () => entry })),
          files: [],
        },
      });
      pane.dispatchEvent(event);
    };
    await act(async () => { drop([fileEntry('notes.txt')]); });
    await settle();

    // Loose files are uploads now, not a rejection. The folder name gets the
    // same slug treatment every webapp-created Drive folder gets.
    expect(view.container.textContent).not.toContain('Drop folders, not loose files');
    expect(folderPosts).toEqual(['starter-files']);
    expect(view.container.querySelector('.tplf-side')?.textContent).toContain('starter-files');
    expect(view.container.querySelector('.tplf-side')?.textContent).toContain('1 file');

    // A second drop reuses the folder instead of minting another.
    await act(async () => { drop([fileEntry('more.txt')]); });
    await settle();
    expect(folderPosts).toEqual(['starter-files']);
    expect(view.container.querySelector('.tplf-side')?.textContent).toContain('2 files');

    const putKeys = fetcher.mock.calls
      .filter(([, init]) => init?.method === 'PUT')
      .map(([input]) => new URL(String(input)).pathname);
    expect(putKeys).toEqual([
      '/folders/folder-files/objects/notes.txt',
      '/folders/folder-files/objects/more.txt',
    ]);
    await view.unmount();
  });

  it('uploads files picked through the Upload menu', async () => {
    const filesFolder = {
      id: 'folder-files',
      name: 'new-template-files',
      role: 'owner',
      orgRole: null,
      owner: { name: 'Min Song', avatarUrl: null },
      attachedWorkspaceIds: [],
      createdAt: 4,
      updatedAt: 4,
      grants: [],
    };
    const folderPosts: string[] = [];
    const fetcher = stub((url, init) => {
      if (url.pathname === '/folders' && init?.method === 'POST') {
        folderPosts.push(String(JSON.parse(String(init.body)).name));
        return Response.json({ folder: filesFolder }, { status: 201 });
      }
      if (url.pathname === '/folders' && init?.method === undefined && folderPosts.length > 0) {
        return Response.json({ folders: [...folders, filesFolder] });
      }
      if (init?.method === 'PUT' && url.pathname.startsWith('/folders/folder-files/objects/')) {
        return new Response(null, { status: 200 });
      }
      return null;
    });
    const { view } = await screenWith(fetcher);
    // The section reads as files, not folders-only.
    expect([...view.container.querySelectorAll('h2')].map((node) => node.textContent))
      .toContain('Files');

    // One button opens the menu; the menu reaches both pickers.
    await act(async () => {
      uploadButton(view).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(uploadMenuItem(view, 'Files')).toBeDefined();
    expect(uploadMenuItem(view, 'Folder')).toBeDefined();
    await act(async () => {
      uploadMenuItem(view, 'Files').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.container.querySelector('.tplf-upload-menu')).toBeNull();

    const picker = view.container.querySelector<HTMLInputElement>('input[aria-label="Upload files"]')!;
    expect(picker).not.toBeNull();
    const pickedFile = new File(['x'], 'report.pdf');
    // A plain file input carries an empty webkitRelativePath in browsers;
    // jsdom leaves it undefined, so pin the browser shape.
    Object.defineProperty(pickedFile, 'webkitRelativePath', { value: '' });
    Object.defineProperty(picker, 'files', { value: [pickedFile] });
    await act(async () => {
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();

    // No template name yet, so the fallback folder name applies.
    expect(folderPosts).toEqual(['new-template-files']);
    const putKeys = fetcher.mock.calls
      .filter(([, init]) => init?.method === 'PUT')
      .map(([input]) => new URL(String(input)).pathname);
    expect(putKeys).toEqual(['/folders/folder-files/objects/report.pdf']);
    await view.unmount();
  });

  it('uploads a dropped directory into a new attached folder', async () => {
    const createdFolder = {
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
    let uploaded = false;
    const fetcher = stub((url, init) => {
      if (url.pathname === '/folders' && init?.method === 'POST') {
        uploaded = true;
        return Response.json({ folder: createdFolder }, { status: 201 });
      }
      if (url.pathname === '/folders' && init?.method === undefined && uploaded) {
        return Response.json({ folders: [...folders, createdFolder] });
      }
      if (init?.method === 'PUT' && url.pathname.startsWith('/folders/folder-new/objects/')) {
        return new Response(null, { status: 200 });
      }
      return null;
    });
    const { view } = await screenWith(fetcher);
    const pane = view.container.querySelector('.tplf-main')!;
    const entry = {
      isFile: false,
      isDirectory: true,
      name: 'Field Photos',
      createReader: () => {
        let drained = false;
        return {
          readEntries: (resolve: (entries: unknown[]) => void) => {
            resolve(drained ? [] : [{
              isFile: true,
              isDirectory: false,
              name: 'one.jpg',
              file: (accept: (file: File) => void) => accept(new File(['x'], 'one.jpg')),
            }]);
            drained = true;
          },
        };
      },
    };
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], items: [{ webkitGetAsEntry: () => entry }], files: [] },
    });
    await act(async () => {
      pane.dispatchEvent(event);
    });
    await settle();

    const putKeys = fetcher.mock.calls
      .filter(([, init]) => init?.method === 'PUT')
      .map(([input]) => new URL(String(input)).pathname);
    expect(putKeys).toEqual(['/folders/folder-new/objects/one.jpg']);
    expect(view.container.querySelector('.tplf-side')?.textContent).toContain('field-photos');
    await view.unmount();
  });
});

describe('template screen org-credential config', () => {
  const discordEntry = {
    id: 'discord',
    title: 'Discord',
    summary: 'Bot messaging',
    custody: 'cp',
    oauthAvailable: false,
    oauthConfigured: false,
    personalTokenLabel: null,
    personalTokenHelp: null,
    personalTokenBaseUrlLabel: null,
    adminForm: {
      rootLabel: 'Bot token',
      rootHelp: 'Create it in the vendor console under a service account.',
      placements: [{ kind: 'env', name: 'DISCORD_BOT_TOKEN', fill: 'token' }],
      app: null,
    },
    scopes: [],
  };
  const youtrackEntry = {
    ...discordEntry,
    id: 'youtrack',
    title: 'YouTrack',
    adminForm: null,
    personalTokenLabel: 'Permanent token',
    personalTokenBaseUrlLabel: 'Instance URL',
  };
  // Both cases are legitimate for github: member OAuth exists, and an admin
  // may still store the optional org credential.
  const githubEntry = {
    ...discordEntry,
    id: 'github',
    title: 'GitHub',
    oauthAvailable: true,
  };

  function connectionsStub(extra?: (url: URL, init?: RequestInit) => Response | null) {
    return stub((url, init) => {
      const handled = extra?.(url, init);
      if (handled) return handled;
      if (url.pathname === '/connections/catalog') {
        return Response.json({ providers: [discordEntry, youtrackEntry, githubEntry] });
      }
      if (url.pathname === '/connections' && init?.method === undefined) {
        return Response.json({ connections: [] });
      }
      return null;
    });
  }

  async function tick(view: { container: HTMLElement }, title: string) {
    const label = [...view.container.querySelectorAll<HTMLElement>('.tplf-connection')]
      .find((candidate) => candidate.textContent?.includes(title));
    expect(label, title).toBeDefined();
    const box = label!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => {
      box.click();
    });
  }

  it('marks every catalog row with its provider glyph', async () => {
    connectionsStub();
    const view = await render(
      <CreateTemplateScreen
        client={createControlPlaneClient('https://cp.example')}
        orgName="acme"
        onCreated={vi.fn()}
        onCancel={() => undefined}
      />,
    );
    await settle();
    const rows = [...view.container.querySelectorAll<HTMLElement>('.tplf-connection')];
    expect(rows).toHaveLength(3);
    for (const label of rows) {
      expect(label.querySelector('svg.tplf-connection-glyph'), label.textContent ?? '').not.toBeNull();
    }
    await view.unmount();
  });

  it('opens the inline config form when an admin attaches an unconfigured provider', async () => {
    const puts: [string, unknown][] = [];
    const fetcher = connectionsStub((url, init) => {
      if (url.pathname === '/connections/discord' && init?.method === 'PUT') {
        puts.push([url.pathname, JSON.parse(String(init.body ?? 'null'))]);
        return new Response(null, { status: 204 });
      }
      return null;
    });
    const onCreated = vi.fn();
    const view = await render(
      <CreateTemplateScreen
        client={createControlPlaneClient('https://cp.example')}
        orgName="acme"
        admin
        onCreated={onCreated}
        onCancel={() => undefined}
      />,
    );
    await settle();

    // A real template name first: if the credential save leaked into the host
    // form's submit, the template below would actually be created.
    const name = view.container.querySelector<HTMLInputElement>('input[aria-label="Template name"]')!;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setInputValue === undefined) throw new Error('input value setter unavailable');
    await act(async () => {
      setInputValue.call(name, 'starter');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await tick(view, 'Discord');
    // The form is right there, no extra click: attaching an admin provider
    // without its credential is the state this surface exists to prevent.
    const root = view.container.querySelector<HTMLInputElement>('.tplf-connections input[name="root"]');
    expect(root).not.toBeNull();
    // The admin surface is not a nested <form>: the screen's create form is
    // the only form element on the page.
    expect(view.container.querySelectorAll('form')).toHaveLength(1);
    await act(async () => {
      setInputValue.call(root!, 'test-only-bot-token');
      root!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save');
    expect(save).toBeDefined();
    await act(async () => {
      save!.click();
    });
    await settle();
    expect(puts).toEqual([[
      '/connections/discord',
      {
        provider: 'discord',
        kind: 'static',
        custody: 'cp',
        config: { placements: [{ kind: 'env', name: 'DISCORD_BOT_TOKEN', fill: 'token' }] },
        root: 'test-only-bot-token',
      },
    ]]);
    // Saving the credential is its own errand: nothing submitted the template
    // around it.
    expect(onCreated).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(([input, init]) => (
      new URL(String(input)).pathname === '/workspace-templates' && init?.method === 'POST'
    ))).toEqual([]);
    await view.unmount();
  });

  it('tells members to ask their admin, and never renders them the form', async () => {
    connectionsStub();
    const view = await render(
      <CreateTemplateScreen
        client={createControlPlaneClient('https://cp.example')}
        orgName="acme"
        onCreated={vi.fn()}
        onCancel={() => undefined}
      />,
    );
    await settle();
    await tick(view, 'Discord');
    expect(view.container.querySelector('.tplf-connections input[name="root"]')).toBeNull();
    expect(view.container.textContent).toContain('Ask an admin to add the Discord key.');
    await view.unmount();
  });

  it('shows the org-credential chip instead of a form once one is stored', async () => {
    connectionsStub((url, init) => {
      if (url.pathname === '/connections' && init?.method === undefined) {
        return Response.json({ connections: [{
          name: 'discord',
          provider: 'discord',
          kind: 'static',
          custody: 'cp',
          status: 'active',
          createdBy: 'admin',
          proxyBaseUrl: null,
          orgCredential: true,
        }] });
      }
      return null;
    });
    const view = await render(
      <CreateTemplateScreen
        client={createControlPlaneClient('https://cp.example')}
        orgName="acme"
        admin
        onCreated={vi.fn()}
        onCancel={() => undefined}
      />,
    );
    await settle();
    await tick(view, 'Discord');
    expect(view.container.textContent).toContain('org key');
    expect(view.container.querySelector('.tplf-connections input[name="root"]')).toBeNull();
    // Replacing swaps the one org-wide credential under every template and
    // workspace, so the form opens only after an explicit confirmation.
    const replace = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Replace Discord key');
    expect(replace).toBeDefined();
    await act(async () => {
      replace!.click();
    });
    const confirmation = view.container.querySelector('.webapp-confirmation-dialog');
    expect(confirmation?.textContent).toContain('Replace the Discord key?');
    expect(confirmation?.textContent)
      .toContain('Every template and workspace at this organization switches to the new key immediately.');
    expect(view.container.querySelector('.tplf-connections input[name="root"]')).toBeNull();

    // Escape backs out without opening the form.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(view.container.querySelector('.webapp-confirmation-dialog')).toBeNull();
    expect(view.container.querySelector('.tplf-connections input[name="root"]')).toBeNull();

    await act(async () => {
      [...view.container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Replace Discord key')!.click();
    });
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('.webapp-confirmation-confirm')?.click();
    });
    expect(view.container.querySelector('.tplf-connections input[name="root"]')).not.toBeNull();
    await view.unmount();
  });

  it('never forces the admin form on a provider members can authorize themselves', async () => {
    connectionsStub();
    const view = await render(
      <CreateTemplateScreen
        client={createControlPlaneClient('https://cp.example')}
        orgName="acme"
        admin
        onCreated={vi.fn()}
        onCancel={() => undefined}
      />,
    );
    await settle();
    await tick(view, 'GitHub');
    // Attaching bare is legitimate: members authorize GitHub themselves, so
    // the org credential is an offer behind a button, not a gate.
    expect(view.container.querySelector('.tplf-connections input[name="root"]')).toBeNull();
    expect(view.container.textContent)
      .toContain('Without an org key, members sign in to GitHub themselves.');
    const configure = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Add GitHub key');
    expect(configure).toBeDefined();
    await act(async () => {
      configure!.click();
    });
    expect(view.container.querySelector('.tplf-connections input[name="root"]')).not.toBeNull();

    // Cancelling closes the form but keeps the provider attached: bare is a
    // valid state for a member-path provider.
    const cancel = [...view.container.querySelectorAll('.tplf-connections button')]
      .find((button) => button.textContent === 'Cancel');
    await act(async () => {
      (cancel as HTMLButtonElement).click();
    });
    expect(view.container.querySelector('.tplf-connections input[name="root"]')).toBeNull();
    const github = [...view.container.querySelectorAll<HTMLElement>('.tplf-connection')]
      .find((candidate) => candidate.textContent?.includes('GitHub'));
    expect(github?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    await view.unmount();
  });

  it('tells members a member-path provider is theirs to connect, not an admin errand', async () => {
    connectionsStub();
    const view = await render(
      <CreateTemplateScreen
        client={createControlPlaneClient('https://cp.example')}
        orgName="acme"
        onCreated={vi.fn()}
        onCancel={() => undefined}
      />,
    );
    await settle();
    await tick(view, 'GitHub');
    // Scoped to the section: the repo picker below legitimately routes
    // members to an admin for the org App credential.
    expect(view.container.querySelector('.tplf-connections')?.textContent)
      .not.toContain('Ask an organization admin');
    expect(view.container.textContent).toContain('Members sign in to GitHub themselves.');
    await view.unmount();
  });

  it('explains a per-member provider when it is picked, with no admin form', async () => {
    connectionsStub();
    const view = await render(
      <CreateTemplateScreen
        client={createControlPlaneClient('https://cp.example')}
        orgName="acme"
        admin
        onCreated={vi.fn()}
        onCancel={() => undefined}
      />,
    );
    await settle();
    await tick(view, 'YouTrack');
    // YouTrack is per-member PAT: the template names it, the member pastes
    // inside the workspace. No org form, no ask-your-admin note. It still owes
    // the picker one line saying so — a provider with no admin form used to
    // render a bare checkbox that explained nothing.
    expect(view.container.querySelector('.tplf-connections input[name="root"]')).toBeNull();
    expect(view.container.querySelector('.tplf-connections')?.textContent)
      .not.toContain('Ask an organization admin');
    expect(view.container.querySelector('.tplf-connections')?.textContent)
      .toContain('Members sign in to YouTrack themselves.');
    await view.unmount();
  });

  it('lights up the repo picker when the admin saves the credential inline', async () => {
    // One closure flag stands in for the org credential's existence: the
    // repositories listing 409s and the connections list is empty until the
    // PUT lands, exactly the server's sequencing.
    let stored = false;
    connectionsStub((url, init) => {
      if (url.pathname === '/connections/github' && init?.method === 'PUT') {
        stored = true;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/connections' && init?.method === undefined && stored) {
        return Response.json({ connections: [{
          name: 'github',
          provider: 'github',
          kind: 'static',
          custody: 'cp',
          status: 'active',
          createdBy: 'admin',
          proxyBaseUrl: null,
          orgCredential: true,
        }] });
      }
      if (url.pathname === '/connections/github/repositories' && stored) {
        return Response.json({ repositories: [{ fullName: 'acme/app', private: false }] });
      }
      return null;
    });
    const view = await render(
      <CreateTemplateScreen
        client={createControlPlaneClient('https://cp.example')}
        orgName="acme"
        admin
        onCreated={vi.fn()}
        onCancel={() => undefined}
      />,
    );
    await settle();
    expect(view.container.textContent).toContain('Connect GitHub above first');
    expect(view.container.querySelector('input[aria-label="Filter repositories"]')).toBeNull();

    await tick(view, 'GitHub');
    await act(async () => {
      [...view.container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Add GitHub key')!.click();
    });
    const root = view.container.querySelector<HTMLInputElement>('.tplf-connections input[name="root"]')!;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setInputValue === undefined) throw new Error('input value setter unavailable');
    await act(async () => {
      setInputValue.call(root, 'test-only-app-secret');
      root.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      [...view.container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Save')!.click();
    });
    await settle();

    // No reload: the saved credential refreshed the listing in place.
    expect(view.container.querySelector('input[aria-label="Filter repositories"]')).not.toBeNull();
    expect(view.container.textContent).toContain('acme/app');
    expect(view.container.textContent).not.toContain('Configure the GitHub App first');
    await view.unmount();
  });
});
