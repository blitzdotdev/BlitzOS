import type {
  OrgCredentialGrantSubjectKind,
  OrgCredentialGrantView,
  OrgCredentialView,
} from '@blitzos/schema';

/** What the webapp already holds about the people and places an access row
 * can name (plans/ORG-CREDENTIALS.md §5). The wire carries ids; every surface
 * that shows access resolves them through this.
 *
 * THE WIRE STILL SAYS "GRANT" and this file does not. `OrgCredentialGrantView`
 * and the `grants` field are the control plane's names for the same thing, and
 * they are imported here unchanged — renaming the wire would break every
 * deployed box and agent reading `/agent/credentials`. What a member reads,
 * and what this webapp calls it, is access. */
export type AccessSubjects = {
  orgName: string;
  /** The signed-in member, so their own row reads "You". */
  viewerMembershipId: string | null;
  workspaces: ReadonlyArray<{ id: string; name: string }>;
  /** `avatarUrl` so a member's face is their own picture, the one the rail
   * draws at its foot. Null is the honest state for an account with none, and
   * the face falls back to initials. */
  members: ReadonlyArray<{ id: string; name: string; email: string; avatarUrl: string | null }>;
};

/** The pill everyone with access wears. Kind is never conveyed by colour
 * alone, so the word is on the row. */
export type AccessSubjectTag = 'workspace' | 'member' | 'org';

export function accessSubjectTag(kind: OrgCredentialGrantSubjectKind): AccessSubjectTag {
  if (kind === 'membership') return 'member';
  return kind;
}

type Subject = Pick<OrgCredentialGrantView, 'subjectKind' | 'subjectId'>;

export function accessSubjectLabel(subject: Subject, subjects: AccessSubjects): string {
  if (subject.subjectKind === 'org') return `everyone in ${subjects.orgName}`;
  if (subject.subjectId === null) return 'unknown';
  if (subject.subjectKind === 'workspace') {
    return subjects.workspaces.find(({ id }) => id === subject.subjectId)?.name
      ?? subject.subjectId;
  }
  if (subject.subjectId === subjects.viewerMembershipId) return 'You';
  const member = subjects.members.find(({ id }) => id === subject.subjectId);
  return member === undefined ? subject.subjectId : (member.name || member.email);
}

export function sameAccessSubject(left: Subject, right: Subject): boolean {
  return left.subjectKind === right.subjectKind && left.subjectId === right.subjectId;
}

/** Why an org credential shows in one workspace's Credentials tab (§9):
 * access given to the workspace, to the whole org, or to the viewer's own
 * membership. A plain reader gets `grants: []` on the wire — the credential is
 * readable, the path is not told — which is `'unknown'`. */
export type WorkspaceReadPath = 'workspace' | 'org' | 'membership' | 'unknown';

export function workspaceReadPath(
  credential: Pick<OrgCredentialView, 'grants'>,
  workspaceId: string,
  viewerMembershipId: string | null,
): WorkspaceReadPath {
  if (credential.grants.length === 0) return 'unknown';
  if (credential.grants.some(({ subjectKind, subjectId }) =>
    subjectKind === 'workspace' && subjectId === workspaceId)) return 'workspace';
  if (credential.grants.some(({ subjectKind }) => subjectKind === 'org')) return 'org';
  if (viewerMembershipId !== null && credential.grants.some(({ subjectKind, subjectId }) =>
    subjectKind === 'membership' && subjectId === viewerMembershipId)) return 'membership';
  return 'unknown';
}

/** Decision 3 of the plan: org-wide `write` is allowed, and the UI says out
 * loud what it means. */
export function hasOrgWideWrite(grants: ReadonlyArray<OrgCredentialGrantView>): boolean {
  return grants.some(({ subjectKind, access }) => subjectKind === 'org' && access === 'write');
}

export const ORG_WIDE_WRITE_WARNING = 'Anyone in the org can rotate this.';

/**
 * Which of the two sections a credential belongs in on a member's own
 * Credentials panel: mine, or shared with me.
 *
 * MINE MEANS THE VIEWER IS NAMED, not that the viewer can read it. Two facts
 * put a credential in the first list — the viewer created it, or an access row
 * names their own membership — and both are things they did or something
 * somebody did to them by name. Everything else that reaches them arrives
 * through a place or a crowd (a workspace row, an org-wide row, or a plain
 * reader's empty `grants`), which is the second list.
 *
 * An admin sees neither list: `role === 'admin'` reads the whole store, so the
 * split would put most of the org's keys under "shared with me" on the word of
 * a permission nobody granted them personally.
 */
export function isOwnOrgCredential(
  credential: Pick<OrgCredentialView, 'grants' | 'createdByMembershipId'>,
  viewerMembershipId: string | null,
): boolean {
  if (viewerMembershipId === null) return false;
  if (credential.createdByMembershipId === viewerMembershipId) return true;
  return credential.grants.some(({ subjectKind, subjectId }) =>
    subjectKind === 'membership' && subjectId === viewerMembershipId);
}
