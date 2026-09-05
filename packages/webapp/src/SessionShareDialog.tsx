import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { SessionShareLevel, SessionShareView, WorkspaceMemberView } from '@blitzos/schema';
import { ModalOverlay } from './ModalOverlay';
import type { ControlPlaneClient } from './api';
import './session-share-dialog.css';

/**
 * Sharing one session with one member (plans/LODY-SHARING.md §1, §8 exit test 5).
 *
 * BlitzOS's own dialog, not a vendored one. Lody's sharing is "share with the
 * team", a workspace-wide visibility flip against their cloud; §0.1 of
 * `plans/LODY-SESSIONS.md` is per-member grants against D1, and the two have
 * nothing in common but the word. What IS theirs is the way in: the rail row's
 * own context menu, through `SessionListProps.onShareSessionWithTeam` — an
 * existing prop, so no vendor hunk.
 *
 * THE DIALOG OWNS ITS OWN DATA. It reads the grants for one session and writes
 * them, so `CloudApp` holds one piece of state — which session is open — rather
 * than a share list, a pending level and an error string it does not otherwise
 * use.
 *
 * THE OWNER IS ALWAYS THE CALLER. The rail lists the sessions on the caller's
 * OWN box, because that is the only daemon their runtime is connected to, so a
 * session shared from here is always theirs and the request omits
 * `ownerMembershipId`. A workspace admin sharing somebody else's session is a
 * control-plane capability with no surface yet; it arrives with the grantee-side
 * rail (§8).
 */

export type SessionShareDialogProps = {
  client: Pick<ControlPlaneClient, 'listSessionShares' | 'grantSessionShare' | 'revokeSessionShare'>;
  workspaceId: string;
  sessionId: string;
  /** What the row is called, for the heading. */
  sessionTitle: string;
  /** The workspace's members. The caller is filtered out here rather than by
   * the caller, because "you cannot share with yourself" is this dialog's rule
   * to state. */
  members: WorkspaceMemberView[];
  viewerMembershipId: string;
  onClose: () => void;
};

/** What each member's row offers. `none` is the revoked state and is a real
 * choice, not the absence of one. */
const LEVELS: { value: SessionShareLevel | 'none'; label: string; hint: string }[] = [
  { value: 'none', label: 'No access', hint: 'Private to you' },
  { value: 'ro', label: 'Read-only', hint: 'Follows the conversation and its diffs' },
  { value: 'rw', label: 'Read-write', hint: 'Can prompt, steer, cancel and answer permissions' },
];

function levelFor(shares: SessionShareView[], membershipId: string): SessionShareLevel | 'none' {
  return shares.find((share) => share.granteeMembershipId === membershipId)?.level ?? 'none';
}

export function SessionShareDialog({
  client,
  workspaceId,
  sessionId,
  sessionTitle,
  members,
  viewerMembershipId,
  onClose,
}: SessionShareDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [shares, setShares] = useState<SessionShareView[] | null>(null);
  const [pending, setPending] = useState<{
    membershipId: string;
    level: SessionShareLevel | 'none';
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    closeButton.current?.focus();
  }, []);

  /** Read once on open. Each later write either returns its canonical grant or
   * confirms a revocation, so another list request is not its completion signal. */
  const reload = useCallback(async () => {
    const response = await client.listSessionShares(workspaceId, sessionId);
    setShares(response.granted);
  }, [client, sessionId, workspaceId]);

  useEffect(() => {
    void reload().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [reload]);

  const setLevel = useCallback(
    async (membershipId: string, level: SessionShareLevel | 'none') => {
      const existing = (shares ?? []).find((share) => (
        share.granteeMembershipId === membershipId
      ));
      if (level === 'none' && existing === undefined) return;
      setPending({ membershipId, level });
      setError(null);
      try {
        if (level === 'none') {
          if (existing === undefined) return;
          await client.revokeSessionShare(workspaceId, existing.id);
          setShares((current) => (current ?? []).filter((share) => share.id !== existing.id));
        } else {
          const grant = await client.grantSessionShare(workspaceId, {
            sessionId,
            granteeMembershipId: membershipId,
            level,
          });
          setShares((current) => [
            ...(current ?? []).filter((share) => (
              share.granteeMembershipId !== membershipId
            )),
            grant,
          ]);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setPending(null);
      }
    },
    [client, sessionId, shares, workspaceId],
  );

  const others = members.filter((member) => member.membershipId !== viewerMembershipId);
  const busy = pending !== null;

  return (
    <ModalOverlay onDismiss={onClose} dismissible={!busy}>
      <section
        className="webapp-share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="webapp-share-header">
          <h1 id={titleId}>Share “{sessionTitle}”</h1>
          <p id={descriptionId}>
            This session runs on your machine. A member you share it with follows it live;
            read-write lets them drive it with you. Nothing else on your machine is shared.
          </p>
        </header>
        <div className="webapp-share-body">
          {error !== null && <p className="webapp-share-error" role="alert">{error}</p>}
          {shares === null && <p className="webapp-share-empty">Loading…</p>}
          {shares !== null && others.length === 0 && (
            <p className="webapp-share-empty">
              This workspace has no one else in it yet.
            </p>
          )}
          {shares !== null && others.map((member) => {
            const level = pending?.membershipId === member.membershipId
              ? pending.level
              : levelFor(shares, member.membershipId);
            return (
              <div className="webapp-share-row" key={member.membershipId}>
                <div className="webapp-share-who">
                  <span className="webapp-share-name">{member.name}</span>
                  <span className="webapp-share-role">{member.role}</span>
                </div>
                <div className="webapp-share-levels" role="group" aria-label={`Access for ${member.name}`}>
                  {LEVELS.map((choice) => {
                    // A workspace viewer may receive read-only and never
                    // read-write. The server refuses it with a 400 either way;
                    // disabling the control is what stops the member finding
                    // that out by being told no.
                    const forbidden = choice.value === 'rw' && member.role === 'viewer';
                    return (
                      <button
                        key={choice.value}
                        type="button"
                        className="webapp-action webapp-share-level"
                        aria-pressed={level === choice.value}
                        title={forbidden ? 'A workspace viewer may only receive read-only access' : choice.hint}
                        disabled={busy || forbidden}
                        onClick={() => { void setLevel(member.membershipId, choice.value); }}
                      >
                        {choice.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <footer className="webapp-share-actions">
          <button
            ref={closeButton}
            className="webapp-action"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Done
          </button>
        </footer>
      </section>
    </ModalOverlay>
  );
}
