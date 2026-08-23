import { useCallback, useState } from 'react';
import type { ControlPlaneClient, WorkspaceGrantView } from './api';
import { ShareAccessDialog } from './ShareAccessDialog';

/** Workspace sharing: the shared access dialog over workspace grants. The
 * dialog owns its grant list — nothing upstream re-renders on a share — so
 * every action reloads it here. */
export function ShareWorkspaceDialog({
  client,
  workspaceId,
  workspaceName,
  orgName,
  orgShareRole,
  owner,
  viewerIsOwner = false,
  onClose,
}: {
  client: ControlPlaneClient;
  workspaceId: string;
  workspaceName: string;
  orgName: string;
  orgShareRole: 'editor' | 'viewer' | null;
  owner?: { name: string; avatarUrl: string | null } | null;
  viewerIsOwner?: boolean;
  onClose: () => void;
}) {
  const [grants, setGrants] = useState<WorkspaceGrantView[]>([]);
  const [orgRole, setOrgRole] = useState<'editor' | 'viewer' | null>(orgShareRole);

  const load = useCallback(async () => {
    const { grants: loaded } = await client.listWorkspaceGrants(workspaceId);
    setGrants(loaded);
  }, [client, workspaceId]);

  return (
    <ShareAccessDialog
      client={client}
      name={workspaceName}
      orgName={orgName}
      owner={owner ? { name: owner.name, avatarUrl: owner.avatarUrl, isViewer: viewerIsOwner } : null}
      orgRole={orgRole}
      grants={grants}
      note={
        'Editors can write in terminal, chat, and files. Viewers get a '
        + 'read-only terminal, files, and chat replay.'
      }
      onLoad={load}
      onSetOrgRole={(next) => client.setWorkspaceOrgRole(workspaceId, next)
        .then(() => setOrgRole(next))}
      onGrant={(member) => client.createWorkspaceGrant(workspaceId, member.id, 'editor')
        .then(load)}
      onChangeRole={(grant, role) => client.createWorkspaceGrant(workspaceId, grant.membershipId, role)
        .then(load)}
      onRevoke={(grant) => client.revokeWorkspaceGrant(workspaceId, grant.id)
        .then(load)}
      onClose={onClose}
    />
  );
}
