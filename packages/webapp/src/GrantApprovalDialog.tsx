import type {
  GrantProposalView,
  OrgCredentialView,
  WorkspaceMemberView,
} from '@blitzos/schema';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ControlPlaneClient, MemberView } from './api';
import { caughtErrorMessage } from './error-message';
import {
  approvalGroups,
  approvedChanges,
  initialEdits,
  isEdited,
  type ApprovalRow,
  type ProposalEdit,
} from './grant-approval-model';
import { ModalOverlay } from './ModalOverlay';
import {
  grantSubjectLabel,
  grantSubjectTag,
  type GrantSubjects,
} from './org-credential-grants';
import { AccessToggle } from './settings/OrgCredentialForm';

/** A workspace as the dialog needs it: its name, and whose machine is whose,
 * so a proposal's `machineId` resolves to "in workspace X, on Y's machine". */
export type ApprovalWorkspace = {
  id: string;
  name: string;
  members: ReadonlyArray<Pick<WorkspaceMemberView, 'membershipId' | 'name' | 'machine'>>;
};

/** Where the proposal came from, in names the person knows. The wire carries
 * `machineId` and `membershipId`; the session that asked is not on it, so
 * that fragment is not shown rather than invented. */
export type ProposalOrigin = {
  workspaceName: string | null;
  memberName: string | null;
};

export function proposalOrigin(
  proposal: Pick<GrantProposalView, 'machineId' | 'membershipId'>,
  workspaces: ReadonlyArray<ApprovalWorkspace>,
): ProposalOrigin {
  for (const workspace of workspaces) {
    const member = workspace.members.find(({ machine }) => machine?.id === proposal.machineId);
    if (member !== undefined) return { workspaceName: workspace.name, memberName: member.name };
  }
  return { workspaceName: null, memberName: null };
}

const X_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);
const UNDO_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 7" />
  </svg>
);

function Row({
  row,
  subjects,
  onEdit,
}: {
  row: ApprovalRow;
  subjects: GrantSubjects;
  onEdit: (changeIndex: number, edit: Partial<ProposalEdit>) => void;
}) {
  const label = grantSubjectLabel(row, subjects);
  const subject = (
    <span className="ga-subj">
      <em>{label}</em>
      <span className="machine-chip ga-tag">{grantSubjectTag(row.subjectKind)}</span>
    </span>
  );
  if (row.kind === 'kept') {
    return (
      <div className="ga-row">
        <span className="ga-sign">·</span>{subject}<span className="ga-lvl">{row.access}</span>
      </div>
    );
  }
  if (row.kind === 'removal-skipped') {
    return (
      <div className="ga-row">
        <span className="ga-sign">·</span>{subject}<span className="ga-lvl">{row.access}</span>
        <button
          className="ga-xb"
          type="button"
          title="Re-apply removal"
          aria-label={`Re-apply removal of ${label}`}
          onClick={() => onEdit(row.changeIndex, { skipped: false })}
        >{UNDO_ICON}</button>
      </div>
    );
  }
  if (row.kind === 'removal') {
    return (
      <div className="ga-row ga-row--del">
        <span className="ga-sign">−</span>{subject}<span className="ga-lvl">{row.access}</span>
        <button
          className="ga-xb"
          type="button"
          title="Keep this grant"
          aria-label={`Keep the grant for ${label}`}
          onClick={() => onEdit(row.changeIndex, { skipped: true })}
        >{X_ICON}</button>
      </div>
    );
  }
  if (row.kind === 'addition-skipped') {
    return (
      <div className="ga-row ga-row--skip">
        <span className="ga-sign">·</span>{subject}<span className="ga-lvl">{row.access}</span>
        <button
          className="ga-xb"
          type="button"
          title="Restore this change"
          aria-label={`Restore the grant for ${label}`}
          onClick={() => onEdit(row.changeIndex, { skipped: false })}
        >{UNDO_ICON}</button>
      </div>
    );
  }
  return (
    <div className="ga-row ga-row--add">
      <span className="ga-sign">+</span>{subject}
      {row.hint !== null && <span className="ga-hint">{row.hint}</span>}
      <AccessToggle
        value={row.access}
        label={`Access for ${label}`}
        onChange={(access) => onEdit(row.changeIndex, { access })}
      />
      <button
        className="ga-xb"
        type="button"
        title="Skip this change"
        aria-label={`Skip the grant for ${label}`}
        onClick={() => onEdit(row.changeIndex, { skipped: true })}
      >{X_ICON}</button>
    </div>
  );
}

/**
 * The grant-approval dialog (plans/ORG-CREDENTIALS.md §7a; canonical mock
 * `plans/mockups/grant-approval.html`). An agent proposed grant changes; the
 * person reviews one merged grant list per credential with the changes as
 * inline diff rows, edits them, and approves exactly what goes through.
 *
 * Close is neither approve nor reject: the proposal stays pending and the
 * requests feed can reopen it. Only Reject sends the agent a denial.
 */
export function GrantApprovalDialog({
  client,
  proposal,
  viewer,
  workspaces,
  onClose,
  onResolved,
  onResolveStarted,
  onResolveFailed,
  initialError,
}: {
  client: Pick<ControlPlaneClient, 'listOrgCredentials' | 'listMembers' | 'resolveGrantProposal'>;
  proposal: GrantProposalView;
  viewer: { membershipId: string | null; orgName: string };
  workspaces: ReadonlyArray<ApprovalWorkspace>;
  /** Dismiss without deciding. */
  onClose: () => void;
  /** The server's answer, once the person approved or rejected. */
  onResolved: (proposal: GrantProposalView) => void;
  /** Hide the pending proposal while its decision is in flight. */
  onResolveStarted?: (proposalId: string) => void;
  /** Restore a rejected optimistic decision with its visible refusal. */
  onResolveFailed?: (proposalId: string, message: string) => void;
  initialError?: string | null;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const [credentials, setCredentials] = useState<OrgCredentialView[] | null>(null);
  const [members, setMembers] = useState<MemberView[]>([]);
  const [edits, setEdits] = useState<ProposalEdit[]>(() => initialEdits(proposal));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  useEffect(() => { closeButton.current?.focus(); }, []);
  useEffect(() => {
    const abort = new AbortController();
    void client.listOrgCredentials(abort.signal)
      .then((response) => { if (!abort.signal.aborted) setCredentials(response.credentials); })
      .catch((caught: Error) => {
        // The rows still draw from the proposal alone; only the kept grants
        // are missing, and the person is told why.
        if (!abort.signal.aborted) {
          setCredentials([]);
          setError(caughtErrorMessage(caught, 'Current grants failed to load.'));
        }
      });
    void client.listMembers()
      .then((response) => { if (!abort.signal.aborted) setMembers(response.members); })
      .catch(() => undefined);
    return () => abort.abort();
  }, [client]);

  const subjects = useMemo<GrantSubjects>(() => ({
    orgName: viewer.orgName,
    viewerMembershipId: viewer.membershipId,
    workspaces,
    members,
  }), [members, viewer, workspaces]);
  const origin = proposalOrigin(proposal, workspaces);
  const groups = approvalGroups(proposal, edits, credentials ?? []);
  const live = approvedChanges(proposal, edits);
  const edited = isEdited(proposal, edits);

  const edit = (changeIndex: number, change: Partial<ProposalEdit>) => {
    setEdits((current) => current.map((entry, index) =>
      index === changeIndex ? { ...entry, ...change } : entry));
  };

  const resolve = async (approve: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    onResolveStarted?.(proposal.id);
    try {
      const response = await client.resolveGrantProposal(proposal.id, {
        approve,
        changes: approve ? live : [],
      });
      onResolved(response.proposal);
    } catch (caught) {
      const message = caughtErrorMessage(caught, approve ? 'Approval failed.' : 'Rejection failed.');
      if (onResolveFailed === undefined) setError(message);
      else onResolveFailed(proposal.id, message);
    } finally {
      setBusy(false);
    }
  };

  const plural = (count: number) => `${count} change${count === 1 ? '' : 's'}`;

  return (
    <ModalOverlay onDismiss={onClose} dismissible={!busy}>
      <section
        className="workspace-details-dialog grant-approval-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="grant-approval-title"
      >
            <header className="workspace-details-header">
              <h1 id="grant-approval-title">Approve credential grants</h1>
              <button
                ref={closeButton}
                type="button"
                title="Close — decide later"
                aria-label="Close"
                onClick={onClose}
              >×</button>
            </header>
            <div className="ga-req">
              <div className="ga-req-from">
                <span className="ga-req-agent" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 7V4M8 12h.01M16 12h.01M9 16h6" /></svg>
                </span>
                <b>Agent</b>
                <span>
                  {origin.memberName !== null && ` · on ${origin.memberName}'s machine`}
                  {origin.workspaceName !== null && ` · workspace ${origin.workspaceName}`}
                  {origin.workspaceName === null && ` · machine ${proposal.machineId}`}
                </span>
              </div>
              <p className="ga-req-why">“{proposal.reason}”</p>
            </div>
            <div className="workspace-details-body ga-body">
              <div className="ga-caps">
                <h2 className="cfg-title">Grants after approval</h2>
                {edited && (
                  <button
                    className="ga-restore"
                    type="button"
                    onClick={() => setEdits(initialEdits(proposal))}
                  >Restore proposal</button>
                )}
              </div>
              {error !== null && <p className="workspace-details-error" role="alert">{error}</p>}
              {credentials === null && <p className="workspace-details-status" role="status">Loading current grants…</p>}
              {groups.map((group) => (
                <div key={group.name}>
                  <div className="ga-cname">
                    <code>{group.name}</code>
                    {group.comment !== null && <span className="ga-cmt">{group.comment}</span>}
                  </div>
                  <div className="ga-col" role="list" aria-label={`Grants on ${group.name}`}>
                    {group.rows.map((row, index) => (
                      <div role="listitem" key={`${row.kind}:${row.subjectKind}:${row.subjectId ?? ''}:${row.access}:${index}`}>
                        <Row row={row} subjects={subjects} onEdit={edit} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <footer className="workspace-details-footer cfg-footer ga-foot">
              <p className="cfg-help">Only what you approve is applied — the agent is told exactly what went through.</p>
              <button
                className="webapp-action"
                type="button"
                disabled={busy}
                onClick={() => { void resolve(false); }}
              >Reject all</button>
              <button
                className="webapp-action webapp-action--primary"
                type="button"
                disabled={busy || live.length === 0}
                onClick={() => { void resolve(true); }}
              >
                {live.length === 0
                  ? 'Nothing to approve'
                  : `Approve ${plural(live.length)}${edited ? ' (edited)' : ''}`}
              </button>
            </footer>
      </section>
    </ModalOverlay>
  );
}
