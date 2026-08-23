import type { ControlPlaneClient } from '../api';
import type { FolderView } from '../file-library-api';
import { ShareAccessDialog } from '../ShareAccessDialog';
import { canManageFolder } from './drive-model';

/** Folder sharing: the shared access dialog over folder grants. Grants and
 * the org role live on the folder prop, so every action refreshes through
 * `onChanged` (the Drive's own folder reload) and then reports a snack. */
export function ShareFolderDialog({
  client,
  folder,
  viewerEmail,
  orgName,
  onClose,
  onChanged,
  onSnack,
}: {
  client: ControlPlaneClient;
  folder: FolderView;
  viewerEmail: string;
  orgName: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onSnack: (message: React.ReactNode) => void;
}) {
  const manage = canManageFolder(folder.role);

  return (
    <ShareAccessDialog
      client={client}
      name={folder.name}
      orgName={orgName}
      manage={manage}
      owner={{
        name: folder.owner.name,
        avatarUrl: folder.owner.avatarUrl,
        isViewer: folder.role === 'owner',
      }}
      viewerEmail={viewerEmail}
      orgRole={folder.orgRole}
      grants={folder.grants ?? []}
      note={manage
        ? 'Everyone here can open every file in this folder. Removing access takes effect immediately.'
        : `You have ${folder.role === 'editor' ? 'editor' : 'viewer'} access. Only ${folder.owner.name} or an organization admin can change access.`}
      onSetOrgRole={(next) => client.setFolderOrgRole(folder.id, next)
        .then(() => onChanged())
        .then(() => onSnack(next === null
          ? <span><b>General access removed</b> — only invited people keep access to {folder.name}</span>
          : <span><b>Everyone at {orgName}</b> can now {next === 'editor' ? 'edit' : 'view'} {folder.name}</span>))}
      onGrant={(member) => client.createFolderGrant(folder.id, member.id, 'editor')
        .then(() => onChanged())
        .then(() => onSnack(
          <span><b>{member.name || member.email}</b> can now edit {folder.name}</span>,
        ))}
      onChangeRole={(grant, role) => client.createFolderGrant(folder.id, grant.membershipId, role)
        .then(() => onChanged())
        .then(() => onSnack(
          <span><b>{grant.member.name || grant.member.email}</b> is now a {role} on {folder.name}</span>,
        ))}
      onRevoke={(grant) => client.revokeFolderGrant(folder.id, grant.id)
        .then(() => onChanged())
        .then(() => onSnack(
          <span><b>Access revoked immediately</b> · {grant.member.name || grant.member.email}’s next request — including the next chunk of an upload in flight — is refused</span>,
        ))}
      onClose={onClose}
    />
  );
}
