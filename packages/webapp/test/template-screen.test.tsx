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

function attachButton(view: { container: HTMLElement }): HTMLButtonElement {
  const found = [...view.container.querySelectorAll('button')]
    .find((candidate) => candidate.closest('.tplf-foot') !== null);
  expect(found).toBeDefined();
  return found as HTMLButtonElement;
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
  it('selects with one click, attaches with the button, and posts the template', async () => {
    const fetcher = stub();
    const { view, onCreated } = await screenWith(fetcher);

    // One merged list, Google-Drive-style rows with owner attribution.
    expect(view.container.textContent).not.toContain('Shared with me');
    expect(view.container.querySelector<HTMLDetailsElement>('.blueprint-advanced')?.open).toBe(false);
    expect(row(view, 'datasets').textContent).toContain('me');
    expect(row(view, 'ada-notes').textContent).toContain('Ada Park');
    expect(attachButton(view).disabled).toBe(true);
    expect(attachButton(view).textContent).toContain('Select a folder');

    await act(async () => {
      row(view, 'datasets').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(attachButton(view).textContent).toBe('Attach “datasets”');
    await act(async () => {
      attachButton(view).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.container.querySelector('.tplf-side')?.textContent).toContain('datasets');
    expect(row(view, 'datasets').textContent).toContain('In template');
    expect(attachButton(view).textContent).toBe('Detach “datasets”');

    await act(async () => {
      row(view, 'ada-notes').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      attachButton(view).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.container.querySelector('.tplf-foot-hint')?.textContent).toBe('2 folders attached');

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
          folders: [
            { id: 'folder-mine', name: 'datasets', role: 'owner' },
            { id: 'folder-gone', name: 'lost-notes', role: null },
          ],
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
          folders: [{ id: 'folder-mine', name: 'datasets', role: 'owner' }],
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

  it('enters a folder on double click, walks back up, and keeps the attach target', async () => {
    const { view } = await screenWith();
    const back = view.container.querySelector<HTMLButtonElement>('.tplf-back')!;
    expect(back.disabled).toBe(true);

    await act(async () => {
      row(view, 'ada-notes').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await settle();
    expect(view.container.querySelector('.tplf-crumb')?.textContent).toBe('ada-notes');
    expect(row(view, 'raw').textContent).toContain('1 file');
    expect(row(view, 'report.md').textContent).toContain('128 B');
    expect(attachButton(view).textContent).toBe('Attach “ada-notes”');

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
