import type { OrgCredentialView } from '@blitzos/schema';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneClient } from '../src/api.js';
import type { TenantMe } from '../src/api-adapter.js';
import { OrgCredentialsPanel } from '../src/settings/OrgCredentialsPanel.js';
import { IMPORT_PREVIEW_DEBOUNCE_MS } from '../src/settings/OrgCredentialImport.js';
import { render, settle } from './dom.js';
import { workspaceViewFixture } from './workspace-fixtures.js';

const viewer: TenantMe = {
  identity: { id: 'user-1', email: 'ada@example.com', name: 'Ada Owner', avatarUrl: null },
  membership: { id: 'membership-1', role: 'member' },
  org: { id: 'org-1', slug: 'acme', name: 'Acme', vmLimit: 10 },
  organizations: [],
};

const stripe: OrgCredentialView = {
  id: 'cred-1',
  name: 'STRIPE_API_KEY',
  comment: 'test-mode key, safe for CI',
  createdByMembershipId: 'membership-1',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  grants: [
    { subjectKind: 'workspace', subjectId: 'workspace-one', access: 'read' },
    { subjectKind: 'membership', subjectId: 'membership-1', access: 'write' },
  ],
};

/** A plain reader's view: the name reaches them, the audience does not. */
const sentry: OrgCredentialView = {
  id: 'cred-2',
  name: 'SENTRY_DSN',
  comment: null,
  createdByMembershipId: 'membership-2',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  grants: [],
};

function client(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  return {
    listOrgCredentials: vi.fn().mockResolvedValue({ credentials: [stripe, sentry] }),
    listMembers: vi.fn().mockResolvedValue({
      members: [
        { id: 'membership-1', email: 'ada@example.com', name: 'Ada Owner', avatarUrl: null, role: 'member', status: 'active' },
        { id: 'membership-2', email: 'dana@example.com', name: 'Dana Reyes', avatarUrl: null, role: 'admin', status: 'active' },
        { id: 'membership-3', email: 'gone@example.com', name: 'Gone Person', avatarUrl: null, role: 'member', status: 'disabled' },
      ],
    }),
    poll: vi.fn().mockResolvedValue({
      workspaces: [
        workspaceViewFixture({ id: 'workspace-one', name: 'payments' }),
        workspaceViewFixture({ id: 'workspace-two', name: 'api-v2' }),
      ],
    }),
    putOrgCredential: vi.fn().mockResolvedValue({ credential: stripe }),
    revokeOrgCredential: vi.fn().mockResolvedValue(undefined),
    replaceOrgCredentialGrants: vi.fn().mockResolvedValue({ credential: stripe }),
    importOrgCredentials: vi.fn().mockResolvedValue({ results: [], linesRead: 0 }),
    ...overrides,
    // SAFETY: the panel reaches for the reads above and the writes each test names.
  } as unknown as ControlPlaneClient;
}

function typeInto(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const prototype = field instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, text);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

function choose(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function field<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`missing ${selector}`);
  return found;
}

function buttonNamed(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === text);
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

describe('OrgCredentialsPanel', () => {
  it('lists names, comments, creators and access chips — never a value', async () => {
    const view = await render(<OrgCredentialsPanel client={client()} viewer={viewer} />);
    await settle();

    expect(view.container.textContent).toContain('STRIPE_API_KEY');
    expect(view.container.textContent).toContain('test-mode key, safe for CI');
    expect(view.container.textContent).toContain('added by you');
    expect(view.container.textContent).toContain('added by Dana Reyes');
    // Access chips name the kind, the subject and the level, in words.
    const chips = [...view.container.querySelectorAll('.org-access-chip')].map((chip) => chip.textContent);
    expect(chips).toEqual(['workspace payments · read', 'member You · write']);
    // A plain reader's row has no audience and no controls.
    expect(view.container.querySelector('button[aria-label="Rotate SENTRY_DSN"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Rotate STRIPE_API_KEY"]')).not.toBeNull();
    // Write-only: the add field exists, but nothing reads a value back.
    const value = field<HTMLInputElement>(view.container, '[aria-label="Credential value"]');
    expect(value.type).toBe('password');
    expect(value.value).toBe('');
    await view.unmount();
  });

  it('adds a credential with a picked access list, and warns on an org-wide write', async () => {
    const putOrgCredential = vi.fn().mockResolvedValue({ credential: stripe });
    const view = await render(<OrgCredentialsPanel client={client({ putOrgCredential })} viewer={viewer} />);
    await settle();
    const form = field<HTMLFormElement>(view.container, 'form[aria-label="Add a credential"]');

    await act(async () => {
      typeInto(field(form, '[aria-label="Credential name"]'), 'DATABASE_URL');
      typeInto(field(form, '[aria-label="Credential value"]'), 'postgres://secret');
      typeInto(field(form, '[aria-label="Credential comment"]'), 'staging postgres');
    });
    // THE PICKER IS BEHIND THE `+`, and the list is what a member reads first.
    expect(form.querySelector('[aria-label="Access subject kind"]')).toBeNull();
    const openPicker = () => field<HTMLButtonElement>(form, 'button[aria-label="Add access"]').click();

    // A workspace: the picker lists the org's workspaces by name.
    await act(async () => openPicker());
    const workspaceSelect = field<HTMLSelectElement>(form, '[aria-label="Access workspace"]');
    expect([...workspaceSelect.options].map((option) => option.textContent)).toEqual(['payments', 'api-v2']);
    await act(async () => choose(workspaceSelect, 'workspace-two'));
    await act(async () => buttonNamed(form, 'Add access').click());
    // Adding closes the picker again: it is a step, not a permanent fixture.
    expect(form.querySelector('[aria-label="Access subject kind"]')).toBeNull();

    // A member: only active members are offered, and the viewer is "You".
    await act(async () => openPicker());
    await act(async () => choose(field<HTMLSelectElement>(form, '[aria-label="Access subject kind"]'), 'membership'));
    const memberSelect = field<HTMLSelectElement>(form, '[aria-label="Access member"]');
    expect([...memberSelect.options].map((option) => option.textContent)).toEqual(['You', 'Dana Reyes']);
    await act(async () => choose(memberSelect, 'membership-2'));
    await act(async () => choose(field<HTMLSelectElement>(form, '[aria-label="Access level"]'), 'write'));
    await act(async () => buttonNamed(form, 'Add access').click());
    expect(form.textContent).toContain('api-v2');
    expect(form.textContent).toContain('Dana Reyes');

    // Everyone in the org is a row like the others, not a checkbox above them:
    // the broadest audience of all belongs in the list that states the
    // audience. Org-wide read is quiet; org-wide write is said out loud
    // (decision 3).
    expect(form.querySelector('.org-access-warning')).toBeNull();
    await act(async () => openPicker());
    await act(async () => choose(field<HTMLSelectElement>(form, '[aria-label="Access subject kind"]'), 'org'));
    await act(async () => buttonNamed(form, 'Add access').click());
    expect(form.querySelector('.org-access-warning')).toBeNull();
    const orgToggle = field<HTMLElement>(form, '[aria-label="Org-wide access"]');
    await act(async () => buttonNamed(orgToggle, 'write').click());
    expect(form.querySelector('.org-access-warning')?.textContent).toBe('Anyone in the org can rotate this.');

    await act(async () => buttonNamed(form, 'Save credential').click());
    expect(putOrgCredential).toHaveBeenCalledWith({
      name: 'DATABASE_URL',
      value: 'postgres://secret',
      comment: 'staging postgres',
      grants: [
        { subjectKind: 'workspace', subjectId: 'workspace-two', access: 'read' },
        { subjectKind: 'membership', subjectId: 'membership-2', access: 'write' },
        { subjectKind: 'org', subjectId: null, access: 'write' },
      ],
    });
    await settle();
    expect(field<HTMLInputElement>(form, '[aria-label="Credential value"]').value).toBe('');
    await view.unmount();
  });

  it('rotates with a write-only value field and touches neither comment nor access', async () => {
    const putOrgCredential = vi.fn().mockResolvedValue({ credential: stripe });
    const view = await render(<OrgCredentialsPanel client={client({ putOrgCredential })} viewer={viewer} />);
    await settle();

    await act(async () => field<HTMLButtonElement>(view.container, 'button[aria-label="Rotate STRIPE_API_KEY"]').click());
    const form = field<HTMLFormElement>(view.container, 'form[aria-label="Rotate STRIPE_API_KEY"]');
    const name = field<HTMLInputElement>(form, '[aria-label="Credential name"]');
    expect(name.value).toBe('STRIPE_API_KEY');
    expect(name.readOnly).toBe(true);
    // No comment field and no access card: rotation changes the secret only.
    expect(form.querySelector('[aria-label="Credential comment"]')).toBeNull();
    expect(form.querySelector('.org-access-editor')).toBeNull();
    expect(form.textContent).not.toContain('Members with access');

    await act(async () => typeInto(field(form, '[aria-label="Credential value"]'), 'sk_live_new'));
    await act(async () => buttonNamed(form, 'Rotate').click());
    expect(putOrgCredential).toHaveBeenCalledWith({ name: 'STRIPE_API_KEY', value: 'sk_live_new' });
    await settle();
    // Back to the add form once the write settled.
    expect(view.container.querySelector('form[aria-label="Add a credential"]')).not.toBeNull();
    await view.unmount();
  });

  it('revokes after a confirmation', async () => {
    const revokeOrgCredential = vi.fn().mockResolvedValue(undefined);
    const view = await render(<OrgCredentialsPanel client={client({ revokeOrgCredential })} viewer={viewer} />);
    await settle();

    await act(async () => field<HTMLButtonElement>(view.container, 'button[aria-label="Revoke STRIPE_API_KEY"]').click());
    expect(revokeOrgCredential).not.toHaveBeenCalled();
    await act(async () => buttonNamed(document.body, 'Revoke credential').click());
    expect(revokeOrgCredential).toHaveBeenCalledWith('STRIPE_API_KEY');
    await view.unmount();
  });

  it('edits an access list and saves the whole audience', async () => {
    const replaceOrgCredentialGrants = vi.fn().mockResolvedValue({ credential: stripe });
    const view = await render(<OrgCredentialsPanel client={client({ replaceOrgCredentialGrants })} viewer={viewer} />);
    await settle();

    await act(async () => field<HTMLButtonElement>(view.container, 'button[aria-label="Edit access for STRIPE_API_KEY"]').click());
    const editor = field<HTMLElement>(view.container, '[aria-label="Access to STRIPE_API_KEY"]');
    expect(editor.textContent).toContain('payments');
    // Widen the workspace to write, and drop the viewer's own access.
    const level = field<HTMLElement>(editor, '[aria-label="Access for payments"]');
    await act(async () => buttonNamed(level, 'write').click());
    await act(async () => field<HTMLButtonElement>(editor, 'button[aria-label="Remove access for You"]').click());
    await act(async () => buttonNamed(editor, 'Save access').click());
    expect(replaceOrgCredentialGrants).toHaveBeenCalledWith('STRIPE_API_KEY', {
      grants: [{ subjectKind: 'workspace', subjectId: 'workspace-one', access: 'write' }],
    });
    await settle();
    expect(view.container.querySelector('[aria-label="Access to STRIPE_API_KEY"]')).toBeNull();
    await view.unmount();
  });

  it('previews an env paste as a dry run, then imports the same text', async () => {
    const importOrgCredentials = vi.fn().mockResolvedValue({
      results: [
        { name: 'CF_TOKEN', line: 1, outcome: 'rotated' },
        { name: 'NEW_KEY', line: 2, outcome: 'stored' },
        {
          name: 'GOOGLE_SA_JSON',
          line: 3,
          outcome: 'refused',
          reason: 'value spans more than one line; base64-encode it first',
        },
      ],
      linesRead: 3,
    });
    const listOrgCredentials = vi.fn().mockResolvedValue({ credentials: [stripe, sentry] });
    const view = await render(
      <OrgCredentialsPanel client={client({ importOrgCredentials, listOrgCredentials })} viewer={viewer} />,
    );
    await settle();

    const text = 'CF_TOKEN=new\nNEW_KEY=x\nGOOGLE_SA_JSON="{\n';
    await act(async () => typeInto(field(view.container, '[aria-label="Env file text"]'), text));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, IMPORT_PREVIEW_DEBOUNCE_MS + 50));
    });

    // The preview IS the import request with `dryRun` set, so the rows it
    // shows are the outcomes the button will produce.
    expect(importOrgCredentials).toHaveBeenCalledWith({ text, dryRun: true });
    expect(view.container.textContent).toContain('base64-encode it first');
    const importButton = [...view.container.querySelectorAll('button')]
      .find((button) => button.textContent?.startsWith('Import'));
    // Two keys will write: stored and rotated. The refused row never counts.
    expect(importButton?.textContent).toBe('Import 2 keys');
    expect(importButton?.disabled).toBe(false);

    await act(async () => importButton?.click());
    expect(importOrgCredentials).toHaveBeenLastCalledWith({ text });
    await settle();
    expect(view.container.textContent).toContain('Imported');
    // The list re-reads once the keys have landed.
    expect(listOrgCredentials).toHaveBeenCalledTimes(2);
    await view.unmount();
  });
});
