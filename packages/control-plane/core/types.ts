/**
 * Who a guest is when it calls the control plane.
 *
 * Two kinds of guest present a token. A MACHINE is one member's VM in one
 * workspace. A BOX is a device-code enrolment with no workspace.
 * Machine identity comes from `machines` at call time. This prevents a
 * machine from acting as a prior member.
 */
export interface BoxIdentity {
  id: string;
  principalId: string;
  workspaceId: string | null;
  /** The org membership a machine acts as. Null for a device-code box. */
  membershipId: string | null;
  platformOperator: boolean;
}
