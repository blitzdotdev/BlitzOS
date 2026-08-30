import { useMemo } from 'react';
import { getCodeCollabMaxRoleForWorkspaceMember, type CodeCollabRole } from '@lody/shared';
import { useOrganization } from './useOrganization';

// Derives the Code Collab edit capability exposed by the UI from workspace
// membership. v2 file operations still go through Machine RPC authorization;
// this value only drives local read/write affordances such as save buttons.
//
// Mapping (from `getCodeCollabMaxRoleForWorkspaceMember`):
//   workspace owner/admin/member → 'write'
//   workspace viewer/read/guest → 'read'
//   non-member / unknown        → 'read' (fallback; server will
//                                  reject as 'not-workspace-member'
//                                  if the user really has no role)
//
// `host` is reserved for the CLI machine boundary; web users never use it.
export function useCodeCollabRequestedRole(): CodeCollabRole {
  const { role: workspaceRole } = useOrganization();
  return useMemo(() => {
    return getCodeCollabMaxRoleForWorkspaceMember({ workspaceRole }) ?? 'read';
  }, [workspaceRole]);
}
