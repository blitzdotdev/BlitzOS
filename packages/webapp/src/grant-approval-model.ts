import type {
  GrantChange,
  GrantProposalView,
  OrgCredentialAccess,
  OrgCredentialGrantSubjectKind,
  OrgCredentialView,
} from '@blitzos/schema';
import { sameGrantSubject } from './org-credential-grants';

/**
 * The editable diff behind the grant-approval dialog
 * (plans/ORG-CREDENTIALS.md §7a, mock `plans/mockups/grant-approval.html`).
 *
 * The proposal is a change list; the person sees one merged grant list per
 * credential and edits the changes in place. This module holds the state of
 * those edits and derives the rows and the resolve payload from it, so the
 * dialog only draws.
 */

/** One proposed change's edit state, aligned by index with
 * `proposal.proposed`. `access` only matters on an addition. */
export type ProposalEdit = {
  skipped: boolean;
  access: OrgCredentialAccess;
};

export function initialEdits(proposal: Pick<GrantProposalView, 'proposed'>): ProposalEdit[] {
  return proposal.proposed.map((change) => ({ skipped: false, access: change.access }));
}

export type ApprovalRow = {
  subjectKind: OrgCredentialGrantSubjectKind;
  subjectId: string | null;
  access: OrgCredentialAccess;
} & (
  /** A grant the proposal leaves alone. */
  | { kind: 'kept' }
  /** A removal, live: the row goes if approved. */
  | { kind: 'removal'; changeIndex: number }
  /** A removal the person skipped: the grant stays, with an undo. */
  | { kind: 'removal-skipped'; changeIndex: number }
  /** An addition, live, at the access the person chose. */
  | { kind: 'addition'; changeIndex: number; hint: string | null }
  /** An addition the person skipped: an outlined no-op with an undo. */
  | { kind: 'addition-skipped'; changeIndex: number }
);

export type ApprovalGroup = {
  name: string;
  comment: string | null;
  rows: ApprovalRow[];
};

/** A redundant addition gets a hint rather than a silent drop: an org-wide
 * grant at the same or a higher level already covers the subject. */
function coverageHint(
  addition: GrantChange,
  current: ReadonlyArray<OrgCredentialView['grants'][number]>,
  removedOrg: (access: OrgCredentialAccess) => boolean,
  access: OrgCredentialAccess,
): string | null {
  if (addition.subjectKind === 'org') return null;
  const orgGrant = current.find((grant) => grant.subjectKind === 'org' && !removedOrg(grant.access));
  if (orgGrant === undefined) return null;
  if (orgGrant.access === 'write' || access === 'read') return `covered by org-wide ${orgGrant.access}`;
  return null;
}

/** The merged list: only the credentials the proposal touches, in the order
 * it first names them; kept grants first, then the additions. A credential
 * the viewer cannot see (revoked meanwhile, or no read) still gets its rows
 * from the proposal alone, with no kept grants to show. */
export function approvalGroups(
  proposal: Pick<GrantProposalView, 'proposed'>,
  edits: ReadonlyArray<ProposalEdit>,
  credentials: ReadonlyArray<OrgCredentialView>,
): ApprovalGroup[] {
  const names: string[] = [];
  for (const change of proposal.proposed) {
    if (!names.includes(change.name)) names.push(change.name);
  }
  return names.map((name) => {
    const credential = credentials.find((candidate) => candidate.name === name);
    const current = credential?.grants ?? [];
    const changes = proposal.proposed
      .map((change, changeIndex) => ({ change, changeIndex, edit: edits[changeIndex] }))
      .filter((entry): entry is typeof entry & { edit: ProposalEdit } =>
        entry.change.name === name && entry.edit !== undefined);
    const removals = changes.filter(({ change }) => change.action === 'remove');
    const additions = changes.filter(({ change }) => change.action === 'add');
    const removedOrg = (access: OrgCredentialAccess) => removals.some(({ change, edit }) =>
      !edit.skipped && change.subjectKind === 'org' && change.access === access);

    const rows: ApprovalRow[] = current.map((grant) => {
      const removal = removals.find(({ change }) =>
        sameGrantSubject(change, grant) && change.access === grant.access);
      if (removal === undefined) return { kind: 'kept', ...grant };
      return removal.edit.skipped
        ? { kind: 'removal-skipped', changeIndex: removal.changeIndex, ...grant }
        : { kind: 'removal', changeIndex: removal.changeIndex, ...grant };
    });
    // A removal the viewer's list does not hold (a plain reader's `[]`, or a
    // grant gone meanwhile) still shows, so nothing in the proposal is hidden.
    for (const { change, changeIndex, edit } of removals) {
      if (current.some((grant) => sameGrantSubject(change, grant) && change.access === grant.access)) continue;
      rows.push(edit.skipped
        ? { kind: 'removal-skipped', changeIndex, subjectKind: change.subjectKind, subjectId: change.subjectId, access: change.access }
        : { kind: 'removal', changeIndex, subjectKind: change.subjectKind, subjectId: change.subjectId, access: change.access });
    }
    for (const { change, changeIndex, edit } of additions) {
      const subject = { subjectKind: change.subjectKind, subjectId: change.subjectId };
      rows.push(edit.skipped
        ? { kind: 'addition-skipped', changeIndex, ...subject, access: change.access }
        : {
            kind: 'addition',
            changeIndex,
            ...subject,
            access: edit.access,
            hint: coverageHint(change, current, removedOrg, edit.access),
          });
    }
    return { name, comment: credential?.comment ?? null, rows };
  });
}

/** What Approve sends: the proposal minus the skipped rows, additions at the
 * access the person chose. Removals keep the access they named — a removal
 * deletes exactly the grant it names. */
export function approvedChanges(
  proposal: Pick<GrantProposalView, 'proposed'>,
  edits: ReadonlyArray<ProposalEdit>,
): GrantChange[] {
  return proposal.proposed.flatMap((change, index) => {
    const edit = edits[index];
    if (edit === undefined || edit.skipped) return [];
    return [change.action === 'add' ? { ...change, access: edit.access } : change];
  });
}

/** The "(edited)" marker: anything skipped, or an addition at another
 * level than proposed. */
export function isEdited(
  proposal: Pick<GrantProposalView, 'proposed'>,
  edits: ReadonlyArray<ProposalEdit>,
): boolean {
  return proposal.proposed.some((change, index) => {
    const edit = edits[index];
    return edit !== undefined
      && (edit.skipped || (change.action === 'add' && edit.access !== change.access));
  });
}
