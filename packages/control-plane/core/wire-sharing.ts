/**
 * Session-sharing wire types, split out of `wire.ts` for the same reason
 * `wire-machines.ts` was: that file is at the 700-line warn and every addition
 * has to go somewhere. `wire.ts` re-exports these, so every consumer keeps one
 * import.
 *
 * `packages/schema/src/workspace.ts` holds the identical declarations and
 * `test/wire-drift.test.ts` proves the two never diverge — core may not import
 * `@blitzos/schema`, so the duplication is deliberate and the test is the
 * mechanism.
 */

/** One granted session, as both halves of the share UI read it.
 *
 * `sessionId` is the Lody session id and is opaque to the control plane
 * (plans/LODY-SHARING.md §1.1): the daemon on the owner's box is the only thing
 * that knows which sessions exist. */
export interface SessionShareView {
  id: string;
  sessionId: string;
  /** The membership whose machine runs the session. */
  ownerMembershipId: string;
  granteeMembershipId: string;
  level: SessionShareLevel;
  createdAt: number;
  createdByMembershipId: string;
}

/** Read-only follows the transcript and the session's diffs; read-write is a
 * full co-driver (prompt, steer, cancel, answer a permission request). */
export type SessionShareLevel = "ro" | "rw";

/** Both halves of one screen: `granted` is what the caller may manage — their
 * own shares, or every share in the workspace for an admin — and `received` is
 * what other members have shared with the caller. One route, because the share
 * dialog reads the first and the rail reads the second. */
export interface ListSessionSharesResponse {
  granted: SessionShareView[];
  received: SessionShareView[];
}

/** Grant, or change an existing grant's level: the write upserts on
 * (workspace, session, grantee), so re-granting at another level is this same
 * call. `ownerMembershipId` defaults to the caller, which is the ordinary case;
 * a workspace admin may name another member, which is how §0.1's "admins
 * grant/revoke" works without the admin owning the session. */
export interface GrantSessionShareRequest {
  sessionId: string;
  granteeMembershipId: string;
  level: SessionShareLevel;
  ownerMembershipId?: string;
}
