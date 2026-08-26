import type { PresenceMemberView, PresenceSnapshotResponse } from '@blitzos/schema';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  membersInWorkspace,
  membersOnSession,
  OrgPresence,
  otherPresenceMembers,
  PresenceFaceStack,
  presenceSections,
} from '../src/OrgPresence';
import { render } from './dom';

function member(
  membershipId: string,
  name: string,
  activities: PresenceMemberView['activities'],
  state: PresenceMemberView['state'] = 'active',
): PresenceMemberView {
  return { membershipId, userId: `user-${membershipId}`, name, avatarUrl: null, state, activities };
}

const here = member('ada', 'Ada', [{
  location: 'workspace',
  workspaceId: 'workspace-one',
  workspaceName: 'Prototype',
  surfaces: [{
    kind: 'session',
    sessionId: 'session-one',
    sessionKind: 'claude',
    title: 'Pairing',
  }],
  focusedSurface: 0,
  focused: true,
  visible: true,
  lastSeenAt: 10,
}]);

const redacted = member('lin', 'Lin', [{
  location: 'other-workspace',
  focused: false,
  visible: true,
  lastSeenAt: 9,
}], 'online');

const online = member('max', 'Max', [{
  location: 'organization',
  focused: false,
  visible: false,
  lastSeenAt: 8,
}], 'away');

const self = member('self', 'Me', [{
  location: 'organization',
  focused: true,
  visible: true,
  lastSeenAt: 11,
}]);

function snapshot(members: PresenceMemberView[]): PresenceSnapshotResponse {
  return { serverTime: 12, expiresAfterMs: 35_000, truncated: false, members };
}

describe('organization presence UI', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('filters the viewer and derives workspace/session indicators without basename matching', () => {
    const collaborators = otherPresenceMembers(snapshot([self, here, redacted, online]), 'self');
    expect(collaborators.map(({ membershipId }) => membershipId)).toEqual(['ada', 'lin', 'max']);
    expect(membersInWorkspace(collaborators, 'workspace-one')).toEqual([here]);
    expect(membersOnSession(collaborators, 'workspace-one', 'session-one')).toEqual([here]);
    expect(membersOnSession(collaborators, 'workspace-one', 'other-session')).toEqual([]);
    const hidden = member('hidden', 'Hidden', [{
      ...here.activities[0]!,
      visible: false,
      focused: false,
    }], 'away');
    expect(membersInWorkspace([...collaborators, hidden], 'workspace-one')).toEqual([here]);
    expect(presenceSections(collaborators, 'workspace-one').map((section) => ({
      id: section.id,
      members: section.members.map(({ member }) => member.membershipId),
    }))).toEqual([
      { id: 'here', members: ['ada'] },
      { id: 'other', members: ['lin'] },
      { id: 'online', members: ['max'] },
    ]);
  });

  it('opens an accessible grouped popover and deep-links only authorized activity', async () => {
    const onNavigate = vi.fn();
    const view = await render(
      <OrgPresence
        snapshot={snapshot([self, here, redacted, online])}
        stale={false}
        viewerMembershipId="self"
        activeWorkspaceId="workspace-one"
        onNavigate={onNavigate}
      />,
    );
    const trigger = view.container.querySelector<HTMLButtonElement>('.org-presence-trigger');
    expect(trigger?.getAttribute('aria-label')).toBe('3 collaborators online: Ada, Lin, Max');
    await act(async () => trigger?.click());

    const dialog = view.container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.hidden).toBe(false);
    expect(dialog?.querySelector('header strong')?.textContent).toBe('3 online');
    expect(dialog?.querySelector('header')?.textContent).not.toContain('Organization');
    expect(dialog?.textContent).toContain('Here');
    expect(dialog?.textContent).toContain('Prototype · Pairing');
    expect(dialog?.textContent).toContain('In another workspace');
    expect(dialog?.textContent).toContain('Online');
    expect(dialog?.textContent).not.toContain('workspace-one');

    const links = [...view.container.querySelectorAll<HTMLButtonElement>(
      '.org-presence-member__activities button',
    )];
    expect(links).toHaveLength(1);
    await act(async () => links[0]?.click());
    expect(onNavigate).toHaveBeenCalledWith('workspace-one', 'session-one');
    expect(dialog?.hidden).toBe(true);
    await view.unmount();
  });

  it('closes on Escape, announces actual joins, and reports truncation', async () => {
    const first = snapshot([self, here]);
    const view = await render(
      <OrgPresence
        snapshot={first}
        stale={false}
        viewerMembershipId="self"
        activeWorkspaceId="workspace-one"
        onNavigate={() => undefined}
      />,
    );
    const trigger = view.container.querySelector<HTMLButtonElement>('.org-presence-trigger');
    await act(async () => trigger?.click());
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(view.container.querySelector<HTMLElement>('[role="dialog"]')?.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);

    const rerender = async (next: PresenceSnapshotResponse | null, stale = false) => act(async () => view.root.render(
      <OrgPresence
        snapshot={next}
        stale={stale}
        viewerMembershipId="self"
        activeWorkspaceId="workspace-one"
        onNavigate={() => undefined}
      />,
    ));
    const status = () => view.container.querySelector('[role="status"]')?.textContent;
    await rerender(snapshot([self, here, redacted]));
    expect(status()).toBe('Lin joined');
    // A refresh with the same people (only clocks moved) announces nothing new.
    await rerender(snapshot([self, here, { ...redacted, activities: [{ ...redacted.activities[0]!, lastSeenAt: 99 }] }]));
    expect(status()).toBe('Lin joined');
    // The announcement clears so an identical later one can be heard again.
    await act(async () => vi.advanceTimersByTime(4_000));
    expect(status()).toBe('');
    // A truncated snapshot's tail churns; it is not announced as joins/leaves.
    await rerender({ ...snapshot([self, here]), truncated: true });
    expect(status()).toBe('');
    await act(async () => trigger?.click());
    expect(view.container.textContent).toContain('Showing the most active collaborators.');
    // Presence going away entirely is not everyone leaving.
    await rerender(snapshot([self, here, redacted]));
    expect(status()).toBe('Lin joined');
    await act(async () => vi.advanceTimersByTime(4_000));
    await rerender(null);
    expect(status()).toBe('');
    // And when it comes back, the people already there are a new baseline,
    // not a wave of joins.
    await rerender(snapshot([self, here, redacted]));
    expect(status()).toBe('');
    await view.unmount();
  });

  it('moves focus into the popover on open and only takes it back when it still owns it', async () => {
    const view = await render(
      <OrgPresence
        snapshot={snapshot([self, here])}
        stale={false}
        viewerMembershipId="self"
        activeWorkspaceId="workspace-one"
        onNavigate={() => undefined}
      />,
    );
    const trigger = view.container.querySelector<HTMLButtonElement>('.org-presence-trigger');
    await act(async () => trigger?.click());
    const dialog = view.container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.tagName).toBe('BUTTON');

    // Focus tabbed away to something else (a terminal, say): Escape closes
    // the popover but leaves that focus alone.
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    elsewhere.focus();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(dialog?.hidden).toBe(true);
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
    await view.unmount();
  });

  it('shows last-known people as reconnecting, never as live, when stale', async () => {
    const view = await render(
      <OrgPresence
        snapshot={snapshot([self, here])}
        stale
        viewerMembershipId="self"
        activeWorkspaceId="workspace-one"
        onNavigate={() => undefined}
      />,
    );
    const trigger = view.container.querySelector<HTMLButtonElement>('.org-presence-trigger');
    expect(trigger?.getAttribute('aria-label')).toBe('Presence reconnecting; last known: 1 collaborator online: Ada');
    expect(view.container.querySelector('.org-presence--stale')).not.toBeNull();
    await act(async () => trigger?.click());
    expect(view.container.querySelector('.org-presence-popover header')?.textContent).toContain('Reconnecting…');
    expect(view.container.querySelector('.org-presence-popover header')?.textContent).toContain('1 last known');
    await view.unmount();
  });

  it('keeps empty and large organizations compact', async () => {
    const empty = await render(
      <OrgPresence
        snapshot={snapshot([self])}
        stale={false}
        viewerMembershipId="self"
        activeWorkspaceId={null}
        onNavigate={() => undefined}
      />,
    );
    expect(empty.container.querySelector('.org-presence-empty-icon.codicon-person')).not.toBeNull();
    await act(async () => empty.container.querySelector<HTMLButtonElement>('.org-presence-trigger')?.click());
    expect(empty.container.querySelector('.org-presence-popover header strong')?.textContent).toBe('0 online');
    expect(empty.container.textContent).toContain('No other collaborators are online.');
    await empty.unmount();

    const crowd = Array.from({ length: 7 }, (_, index) => member(
      `member-${index}`,
      `Member ${index}`,
      [{ location: 'organization', focused: false, visible: true, lastSeenAt: 10 - index }],
      'online',
    ));
    const large = await render(
      <OrgPresence
        snapshot={snapshot([self, ...crowd])}
        stale={false}
        viewerMembershipId="self"
        activeWorkspaceId={null}
        onNavigate={() => undefined}
      />,
    );
    expect(large.container.querySelectorAll('.org-presence-trigger .org-presence-face')).toHaveLength(3);
    expect(large.container.querySelector('.org-presence-trigger .org-presence-more')?.textContent).toBe('+4');
    await large.unmount();

    const tabDensity = await render(<PresenceFaceStack members={crowd} compact maxFaces={1} />);
    expect(tabDensity.container.querySelectorAll('.org-presence-face')).toHaveLength(1);
    expect(tabDensity.container.querySelector('.org-presence-more')?.textContent).toBe('+6');
    expect(tabDensity.container.querySelector('[role="img"]')?.getAttribute('aria-label'))
      .toContain('7 collaborators online');
    await tabDensity.unmount();
  });
});
