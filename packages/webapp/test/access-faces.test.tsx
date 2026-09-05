import type { OrgCredentialGrantView } from '@blitzos/schema';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { accessFaceInitials, AccessFaces } from '../src/settings/AccessFaces.js';
import type { AccessSubjects } from '../src/org-credential-access.js';
import { render } from './dom.js';

const subjects: AccessSubjects = {
  orgName: 'Acme Widgets',
  viewerMembershipId: 'membership-1',
  workspaces: [
    { id: 'ws-1', name: 'payments' },
    { id: 'ws-2', name: 'api v2' },
    { id: 'ws-3', name: 'canary' },
    { id: 'ws-4', name: 'infra' },
    { id: 'ws-5', name: 'docs site' },
  ],
  members: [
    { id: 'membership-1', name: 'Ada Owner', email: 'ada@example.com', avatarUrl: null },
    { id: 'membership-2', name: 'Dana Reyes', email: 'dana@example.com', avatarUrl: 'https://lh3.googleusercontent.com/photo' },
    { id: 'membership-3', name: 'Priya N', email: 'priya@example.com', avatarUrl: null },
    { id: 'membership-4', name: '', email: 'rio@example.com', avatarUrl: null },
  ],
};

/** A credential shared widely enough that two of the three classes overflow. */
const wide: OrgCredentialGrantView[] = [
  { subjectKind: 'workspace', subjectId: 'ws-1', access: 'read' },
  { subjectKind: 'workspace', subjectId: 'ws-2', access: 'read' },
  { subjectKind: 'workspace', subjectId: 'ws-3', access: 'read' },
  { subjectKind: 'workspace', subjectId: 'ws-4', access: 'read' },
  { subjectKind: 'workspace', subjectId: 'ws-5', access: 'read' },
  { subjectKind: 'membership', subjectId: 'membership-1', access: 'write' },
  { subjectKind: 'membership', subjectId: 'membership-2', access: 'read' },
  { subjectKind: 'membership', subjectId: 'membership-3', access: 'read' },
  { subjectKind: 'membership', subjectId: 'membership-4', access: 'read' },
  { subjectKind: 'org', subjectId: null, access: 'read' },
];

function classes(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.org-access-class')];
}

function facesIn(group: HTMLElement): HTMLElement[] {
  return [...group.querySelectorAll<HTMLElement>('.org-access-face')];
}

describe('AccessFaces', () => {
  it('stacks one class at a time, three faces each, and counts the rest per class', async () => {
    const view = await render(
      <AccessFaces
        credentialName="STRIPE_API_KEY"
        grants={wide}
        subjects={subjects}
        expanded={false}
        onToggle={() => undefined}
      />,
    );

    // Places, then people, then everybody — the strip's fixed reading order,
    // not the order the wire happened to send the rows in.
    const [workspaces, members, org] = classes(view.container);
    expect(classes(view.container)).toHaveLength(3);
    if (workspaces === undefined || members === undefined || org === undefined) throw new Error('missing stack');
    expect(facesIn(workspaces).map((face) => face.className)).toEqual([
      'org-access-face org-access-face--workspace',
      'org-access-face org-access-face--workspace',
      'org-access-face org-access-face--workspace',
    ]);
    expect(facesIn(members).map((face) => face.className)).toEqual([
      'org-access-face org-access-face--member',
      'org-access-face org-access-face--member',
      'org-access-face org-access-face--member',
    ]);
    expect(facesIn(org).map((face) => face.className))
      .toEqual(['org-access-face org-access-face--org']);

    // 5 workspaces − 3 shown = +2; 4 members − 3 = +1; the one org row fits,
    // so it gets no counter. The counters never pool across classes.
    expect(workspaces.querySelector('.org-access-more')?.textContent).toBe('+2');
    expect(workspaces.querySelector('.org-access-more')?.getAttribute('aria-label')).toBe('2 more workspaces');
    expect(members.querySelector('.org-access-more')?.textContent).toBe('+1');
    expect(members.querySelector('.org-access-more')?.getAttribute('aria-label')).toBe('1 more member');
    expect(org.querySelector('.org-access-more')).toBeNull();

    // DOM order is the overlap order: the last face in a stack is painted on
    // top, so the faces have to arrive in the order the grants did.
    expect(facesIn(workspaces).map((face) => face.getAttribute('aria-label')))
      .toEqual(['payments', 'api v2', 'canary']);
    // Every face names its own subject: it is the only thing on the collapsed
    // row that could. The viewer's own membership reads "You"; the org face
    // wears the org's initials, not the sentence's.
    expect(facesIn(members).map((face) => face.getAttribute('aria-label')))
      .toEqual(['You', 'Dana Reyes', 'Priya N']);
    expect(facesIn(org)[0]?.getAttribute('aria-label')).toBe('everyone in Acme Widgets');
    expect(facesIn(org)[0]?.textContent).toBe('AW');
    await view.unmount();
  });

  it('draws no counter for a class that fits, and nothing at all for a plain reader', async () => {
    const exact = await render(
      <AccessFaces
        credentialName="SENTRY_DSN"
        grants={wide.filter(({ subjectKind }) => subjectKind === 'workspace').slice(0, 3)}
        subjects={subjects}
        expanded={false}
        onToggle={() => undefined}
      />,
    );
    expect(exact.container.querySelectorAll('.org-access-face')).toHaveLength(3);
    expect(exact.container.querySelector('.org-access-more')).toBeNull();
    await exact.unmount();

    // A plain reader's wire view carries no audience, so there is no strip and
    // no chevron promising rows that do not exist.
    const none = await render(
      <AccessFaces
        credentialName="SENTRY_DSN"
        grants={[]}
        subjects={subjects}
        expanded={false}
        onToggle={() => undefined}
      />,
    );
    expect(none.container.querySelector('.org-access-strip')).toBeNull();
    await none.unmount();
  });

  it('says what the chevron opens, and reports the state it is in', async () => {
    const onToggle = vi.fn();
    const view = await render(
      <AccessFaces
        credentialName="STRIPE_API_KEY"
        grants={wide}
        subjects={subjects}
        expanded={false}
        onToggle={onToggle}
      />,
    );
    const chevron = view.container.querySelector<HTMLButtonElement>('.org-access-chevron');
    expect(chevron?.getAttribute('aria-expanded')).toBe('false');
    expect(chevron?.getAttribute('aria-label')).toBe('Show who has access to STRIPE_API_KEY');
    await act(async () => chevron?.click());
    expect(onToggle).toHaveBeenCalledTimes(1);

    // The rotation is CSS on `aria-expanded`, so the open state has to be on
    // the attribute and not in a class of its own.
    await act(async () => view.root.render(
      <AccessFaces
        credentialName="STRIPE_API_KEY"
        grants={wide}
        subjects={subjects}
        expanded
        onToggle={onToggle}
      />,
    ));
    const open = view.container.querySelector<HTMLButtonElement>('.org-access-chevron');
    expect(open?.getAttribute('aria-expanded')).toBe('true');
    expect(open?.getAttribute('aria-label')).toBe('Hide who has access to STRIPE_API_KEY');
    await view.unmount();
  });

  it('wears the marks the product already draws for each subject', async () => {
    // The rail draws a workspace as its sigil and the signed-in account as its
    // photo; a credential's audience is read with the same two glyphs, and
    // initials are what is left when an account has no picture.
    const view = await render(
      <AccessFaces
        grants={[
          { subjectKind: 'workspace', subjectId: 'ws-1', access: 'read' },
          { subjectKind: 'membership', subjectId: 'membership-2', access: 'read' },
          { subjectKind: 'membership', subjectId: 'membership-1', access: 'read' },
        ]}
        subjects={subjects}
        expanded={false}
        onToggle={() => undefined}
        credentialName="STRIPE_API_KEY"
      />,
    );

    const workspace = view.container.querySelector('.org-access-face--workspace');
    expect(workspace?.querySelector('svg')).not.toBeNull();
    const faces = [...view.container.querySelectorAll('.org-access-face--member')];
    // Dana has a photo; Ada does not and keeps her initials.
    const photo = faces.find((face) => face.querySelector('img') !== null);
    expect(photo?.querySelector('img')?.getAttribute('src')).toContain('=s128-c');
    const lettered = faces.find((face) => face.querySelector('img') === null);
    expect(lettered?.textContent).toBe('AO');
    await view.unmount();
  });

  it('takes at most two initials, from the words of the label', () => {
    expect(accessFaceInitials('payments')).toBe('P');
    expect(accessFaceInitials('Dana Reyes')).toBe('DR');
    expect(accessFaceInitials('rio@example.com')).toBe('R');
    // A third word is dropped rather than shrunk into a 24px mark.
    expect(accessFaceInitials('one two three')).toBe('OT');
  });
});
