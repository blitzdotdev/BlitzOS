export interface BoxIdentity {
  id: string;
  principalId: string;
  workspaceId: string | null;
  isBroker: boolean;
  platformOperator: boolean;
}
