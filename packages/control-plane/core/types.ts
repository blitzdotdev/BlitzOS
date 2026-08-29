/**
 * Who a guest is when it calls the control plane.
 *
 * Two kinds of guest present a token. A MACHINE is one member's VM in one
 * workspace: `workspaceId` and `membershipId` are set, and both are read off
 * the `machines` row AT CALL TIME. Nothing about the acting principal is
 * stored beside the credential, which is what stops a machine acting as
 * somebody it no longer belongs to. A BOX is a broker or a device-code
 * enrolment: it has no workspace and acts as the principal that enrolled it.
 */
export interface BoxIdentity {
  id: string;
  principalId: string;
  workspaceId: string | null;
  /** The org membership a machine acts as. Null for a broker or device box,
   * which has no workspace and therefore no workspace membership. */
  membershipId: string | null;
  isBroker: boolean;
  platformOperator: boolean;
}
