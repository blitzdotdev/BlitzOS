import type {
  OrgCredentialGrantSubjectKind,
  OrgCredentialGrantView,
  OrgCredentialView,
} from '@blitzos/schema';

/** What the webapp already holds about the people and places a grant can
 * name (plans/ORG-CREDENTIALS.md §5). The wire carries ids; every surface
 * that shows a grant resolves them through this. */
export type GrantSubjects = {
  orgName: string;
  /** The signed-in member, so their own grant reads "You". */
  viewerMembershipId: string | null;
  workspaces: ReadonlyArray<{ id: string; name: string }>;
  members: ReadonlyArray<{ id: string; name: string; email: string }>;
};

/** The pill every grant receiver wears. Kind is never conveyed by colour
 * alone, so the word is on the row. */
export type GrantSubjectTag = 'workspace' | 'member' | 'org';

export function grantSubjectTag(kind: OrgCredentialGrantSubjectKind): GrantSubjectTag {
  if (kind === 'membership') return 'member';
  return kind;
}

type Subject = Pick<OrgCredentialGrantView, 'subjectKind' | 'subjectId'>;

export function grantSubjectLabel(subject: Subject, subjects: GrantSubjects): string {
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

export function sameGrantSubject(left: Subject, right: Subject): boolean {
  return left.subjectKind === right.subjectKind && left.subjectId === right.subjectId;
}

/** Why an org credential shows in one workspace's Credentials tab (§9): a
 * grant on the workspace, an org-wide grant, or the viewer's own membership
 * grant. A plain reader gets `grants: []` on the wire — the credential is
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

/** Decision 3 of the plan: an org-wide `write` is allowed, and the UI says
 * out loud what it means. */
export function hasOrgWideWrite(grants: ReadonlyArray<OrgCredentialGrantView>): boolean {
  return grants.some(({ subjectKind, access }) => subjectKind === 'org' && access === 'write');
}

export const ORG_WIDE_WRITE_WARNING = 'Anyone in the org can rotate this.';
