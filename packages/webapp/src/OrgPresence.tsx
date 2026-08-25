import type {
  PresenceActivityView,
  PresenceMemberView,
  PresenceSnapshotResponse,
  PresenceSurfaceView,
} from '@blitzos/schema';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SESSION_KIND_LABELS } from './session-labels';

const MAX_STACK_FACES = 3;
/** How long a join/leave announcement stays in the live region. Clearing it
 * lets an identical later message announce again. */
const ANNOUNCEMENT_MS = 4_000;

function activityRank(activity: PresenceActivityView, workspaceId: string | null): number {
  if (activity.location === 'workspace' && activity.workspaceId === workspaceId) return 0;
  if (activity.location === 'workspace') return 1;
  if (activity.location === 'other-workspace') return 2;
  return 3;
}

function orderedActivities(
  member: PresenceMemberView,
  workspaceId: string | null,
): PresenceActivityView[] {
  return [...member.activities].sort((left, right) => (
    activityRank(left, workspaceId) - activityRank(right, workspaceId)
    || Number(right.focused) - Number(left.focused)
    || Number(right.visible) - Number(left.visible)
    || right.lastSeenAt - left.lastSeenAt
  ));
}

export function otherPresenceMembers(
  snapshot: PresenceSnapshotResponse | null,
  viewerMembershipId: string | null,
): PresenceMemberView[] {
  return snapshot?.members.filter(({ membershipId }) => membershipId !== viewerMembershipId) ?? [];
}

export function membersInWorkspace(
  members: readonly PresenceMemberView[],
  workspaceId: string,
): PresenceMemberView[] {
  return members.filter(({ activities }) => activities.some((activity) => (
    activity.location === 'workspace'
    && activity.workspaceId === workspaceId
    && activity.visible
  )));
}

export function membersOnSession(
  members: readonly PresenceMemberView[],
  workspaceId: string,
  sessionId: string,
): PresenceMemberView[] {
  return members.filter(({ activities }) => activities.some((activity) => (
    activity.location === 'workspace'
    && activity.workspaceId === workspaceId
    && activity.visible
    && activity.surfaces.some((surface) => (
      surface.kind === 'session' && surface.sessionId === sessionId
    ))
  )));
}

export interface PresenceSection {
  id: 'here' | 'other' | 'online';
  label: string;
  members: Array<{ member: PresenceMemberView; activities: PresenceActivityView[] }>;
}

export function presenceSections(
  members: readonly PresenceMemberView[],
  workspaceId: string | null,
): PresenceSection[] {
  const sections: PresenceSection[] = [
    { id: 'here', label: 'Here', members: [] },
    { id: 'other', label: 'Other workspaces', members: [] },
    { id: 'online', label: 'Online', members: [] },
  ];
  for (const member of members) {
    const activities = orderedActivities(member, workspaceId);
    const primary = activities[0];
    if (primary === undefined) continue;
    const section = primary.location === 'workspace' && primary.workspaceId === workspaceId
      ? sections[0]
      : primary.location === 'organization'
        ? sections[2]
        : sections[1];
    section?.members.push({ member, activities });
  }
  return sections;
}

function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || 'M';
}

/** Says who, not only how many: the faces themselves are decorative. */
export function presenceStackLabel(members: readonly PresenceMemberView[]): string {
  const count = `${members.length} collaborator${members.length === 1 ? '' : 's'} online`;
  if (members.length === 0) return 'No other collaborators online';
  const names = members.slice(0, MAX_STACK_FACES).map(({ name }) => name).join(', ');
  const rest = members.length - MAX_STACK_FACES;
  return rest > 0 ? `${count}: ${names} and ${rest} more` : `${count}: ${names}`;
}

function PresenceFace({ member }: { member: PresenceMemberView }) {
  return (
    <span
      className={`org-presence-face org-presence-face--${member.state}`}
      title={`${member.name} · ${member.state}`}
      aria-hidden="true"
    >
      {member.avatarUrl
        ? <img src={member.avatarUrl} alt="" referrerPolicy="no-referrer" />
        : initial(member.name)}
    </span>
  );
}

export function PresenceFaceStack({
  members,
  compact = false,
}: {
  members: readonly PresenceMemberView[];
  compact?: boolean;
}) {
  if (members.length === 0) return null;
  const visible = members.slice(0, MAX_STACK_FACES);
  const hidden = members.length - visible.length;
  return (
    <span
      className={`org-presence-faces${compact ? ' org-presence-faces--compact' : ''}`}
      role="img"
      aria-label={presenceStackLabel(members)}
    >
      {visible.map((member) => <PresenceFace member={member} key={member.membershipId} />)}
      {hidden > 0 && <span className="org-presence-more" aria-hidden="true">+{hidden}</span>}
    </span>
  );
}

function surfaceLabel(surface: PresenceSurfaceView): string {
  switch (surface.kind) {
    case 'session':
      return surface.title?.trim() || SESSION_KIND_LABELS[surface.sessionKind];
    case 'file':
      return `File · ${surface.label}`;
    case 'preview':
      return `Preview · ${surface.label}`;
    case 'panel':
      return surface.panel === 'previews'
        ? 'Previews'
        : `${surface.panel.charAt(0).toUpperCase()}${surface.panel.slice(1)}`;
    case 'workspace':
      return 'Workspace';
  }
}

function activitySurface(activity: PresenceActivityView): PresenceSurfaceView | null {
  if (activity.location !== 'workspace') return null;
  const focused = activity.focusedSurface === null ? null : activity.surfaces[activity.focusedSurface];
  return focused ?? activity.surfaces[0] ?? null;
}

function activityText(activity: PresenceActivityView): string {
  if (activity.location === 'other-workspace') return 'In another workspace';
  if (activity.location === 'organization') return 'In the organization';
  const surface = activitySurface(activity);
  return surface === null ? activity.workspaceName : `${activity.workspaceName} · ${surfaceLabel(surface)}`;
}

function activitySessionId(activity: PresenceActivityView): string | undefined {
  const surface = activitySurface(activity);
  return surface?.kind === 'session' ? surface.sessionId : undefined;
}

function PresenceMemberRow({
  member,
  activities,
  onNavigate,
}: {
  member: PresenceMemberView;
  activities: readonly PresenceActivityView[];
  onNavigate: (workspaceId: string, sessionId?: string) => void;
}) {
  return (
    <li className="org-presence-member">
      <PresenceFace member={member} />
      <div className="org-presence-member__copy">
        <div className="org-presence-member__name">
          <strong>{member.name}</strong>
          <span className={`org-presence-state org-presence-state--${member.state}`}>{member.state}</span>
        </div>
        <div className="org-presence-member__activities">
          {activities.slice(0, 3).map((activity, index) => (
            activity.location === 'workspace' ? (
              <button
                type="button"
                key={`${activity.workspaceId}-${activity.lastSeenAt}-${index}`}
                onClick={() => onNavigate(activity.workspaceId, activitySessionId(activity))}
              >{activityText(activity)}</button>
            ) : (
              <span key={`${activity.location}-${activity.lastSeenAt}-${index}`}>{activityText(activity)}</span>
            )
          ))}
        </div>
      </div>
    </li>
  );
}

function joinedLeftMessage(
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): string {
  const joined = [...current].filter(([id]) => !previous.has(id)).map(([, name]) => name);
  const left = [...previous].filter(([id]) => !current.has(id)).map(([, name]) => name);
  const parts: string[] = [];
  if (joined.length > 0) parts.push(`${joined.slice(0, 3).join(', ')} joined`);
  if (left.length > 0) parts.push(`${left.slice(0, 3).join(', ')} went offline`);
  return parts.join('. ');
}

export function OrgPresence({
  snapshot,
  stale,
  viewerMembershipId,
  activeWorkspaceId,
  onNavigate,
  onOpenChange,
}: {
  snapshot: PresenceSnapshotResponse | null;
  /** No poll has succeeded within the expiry window: show the last known
   * people dimmed and say so, never as live. */
  stale: boolean;
  viewerMembershipId: string | null;
  /** The workspace the viewer is looking at right now — null on Drive and
   * settings pages, where nobody is "here". */
  activeWorkspaceId: string | null;
  onNavigate: (workspaceId: string, sessionId?: string) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const previousMembers = useRef<Map<string, string> | null>(null);
  const members = useMemo(
    () => otherPresenceMembers(snapshot, viewerMembershipId),
    [snapshot, viewerMembershipId],
  );
  const sections = useMemo(
    () => presenceSections(members, activeWorkspaceId),
    [activeWorkspaceId, members],
  );

  useEffect(() => {
    // Nothing to announce when presence itself goes away (sign-out, polling
    // off): everyone "leaving" at once is not news. The next snapshot starts
    // a fresh baseline instead of announcing everyone as joined.
    if (snapshot === null) {
      previousMembers.current = null;
      return;
    }
    const current = new Map(members.map((member) => [member.membershipId, member.name]));
    // A truncated snapshot's tail churns from poll to poll; announcing that
    // churn would be noise, not joins and leaves.
    if (previousMembers.current !== null && !snapshot.truncated) {
      const message = joinedLeftMessage(previousMembers.current, current);
      if (message !== '') setAnnouncement(message);
    }
    previousMembers.current = current;
  }, [members, snapshot]);

  useEffect(() => {
    if (announcement === '') return;
    const timer = window.setTimeout(() => setAnnouncement(''), ANNOUNCEMENT_MS);
    return () => window.clearTimeout(timer);
  }, [announcement]);

  useEffect(() => {
    if (!open) return;
    // A dialog takes focus when it opens; the first link, or the dialog
    // itself when there is nothing to activate.
    const first = popover.current?.querySelector<HTMLElement>('button');
    (first ?? popover.current)?.focus();
    const closeOnPointerDown = (event: PointerEvent) => {
      // SAFETY: Browser pointer-event targets used for DOM containment are Nodes.
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      // Return focus only if it is still ours: Escape pressed in a terminal
      // that was reached by tabbing away must not yank focus back to the rail.
      if (wrapper.current?.contains(document.activeElement)) trigger.current?.focus();
    };
    window.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const navigate = (workspaceId: string, sessionId?: string) => {
    setOpen(false);
    onNavigate(workspaceId, sessionId);
  };

  const label = presenceStackLabel(members);
  return (
    <div className={`org-presence${stale ? ' org-presence--stale' : ''}`} ref={wrapper}>
      <button
        className="org-presence-trigger"
        type="button"
        ref={trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="org-presence-popover"
        aria-label={stale ? `Presence reconnecting; last known: ${label}` : label}
        title={stale ? 'Organization presence · reconnecting' : 'Organization presence'}
        onClick={() => setOpen((current) => {
          const next = !current;
          onOpenChange?.(next);
          return next;
        })}
      >
        {members.length > 0
          ? <span aria-hidden="true"><PresenceFaceStack members={members} compact /></span>
          : <span className="org-presence-empty-icon" aria-hidden="true"><i /><i /></span>}
      </button>
      <div
        className="org-presence-popover"
        id="org-presence-popover"
        role="dialog"
        aria-label="Organization presence"
        hidden={!open}
        tabIndex={-1}
        ref={popover}
      >
        <header>
          <strong>Organization</strong>
          <span>{stale ? 'Reconnecting…' : `${members.length} online`}</span>
        </header>
        {members.length === 0 ? (
          <p className="org-presence-empty">No other collaborators are online.</p>
        ) : sections.map((section) => section.members.length > 0 && (
          <section className="org-presence-section" key={section.id} aria-labelledby={`presence-${section.id}`}>
            <h2 id={`presence-${section.id}`}>{section.label}</h2>
            <ul>
              {section.members.map(({ member, activities }) => (
                <PresenceMemberRow
                  member={member}
                  activities={activities}
                  onNavigate={navigate}
                  key={member.membershipId}
                />
              ))}
            </ul>
          </section>
        ))}
        {snapshot?.truncated && (
          <p className="org-presence-truncated">Showing the most active collaborators.</p>
        )}
      </div>
      <span className="org-presence-live" role="status" aria-live="polite">{announcement}</span>
    </div>
  );
}
