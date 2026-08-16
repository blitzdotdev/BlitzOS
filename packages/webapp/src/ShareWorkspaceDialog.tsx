import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ControlPlaneClient, MemberView, WorkspaceGrantView } from './api';

export function ShareWorkspaceDialog({
  client,
  workspaceId,
  workspaceName,
  onClose,
}: {
  client: ControlPlaneClient;
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<MemberView[]>([]);
  const [grants, setGrants] = useState<WorkspaceGrantView[]>([]);
  const [membershipId, setMembershipId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [memberResponse, grantResponse] = await Promise.all([
        client.listMembers(),
        client.listWorkspaceGrants(workspaceId),
      ]);
      setMembers(memberResponse.members);
      setGrants(grantResponse.grants);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load sharing settings.');
    }
  }, [client, workspaceId]);
  useEffect(() => { void load(); }, [load]);
  const granted = useMemo(() => new Set(grants.map((grant) => grant.membershipId)), [grants]);
  const candidates = members.filter((member) => member.status === 'active' && !granted.has(member.id));

  return (
    <div className="confirmation-backdrop" role="presentation">
      <section className="confirmation-dialog" role="dialog" aria-modal="true" aria-label={`Share ${workspaceName}`}>
        <h2>Share {workspaceName}</h2>
        <p>Editors can use terminal, chat, and files. They cannot destroy or manage credentials.</p>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!membershipId) return;
          void client.createWorkspaceGrant(workspaceId, membershipId).then(() => {
            setMembershipId('');
            return load();
          }).catch((caught: Error) => setError(caught.message));
        }}>
          <select aria-label="Member" value={membershipId} onChange={(event) => setMembershipId(event.currentTarget.value)}>
            <option value="">Select member</option>
            {candidates.map((member) => <option key={member.id} value={member.id}>{member.name || member.email}</option>)}
          </select>
          <select aria-label="Workspace role" value="editor" disabled><option value="editor">Editor</option></select>
          <button type="submit" disabled={!membershipId}>Share</button>
        </form>
        {error && <p role="alert">{error}</p>}
        <ul>
          {grants.map((grant) => <li key={grant.id}><span>{grant.member.name || grant.member.email} · editor</span><button type="button" onClick={() => void client.revokeWorkspaceGrant(workspaceId, grant.id).then(load).catch((caught: Error) => setError(caught.message))}>Revoke</button></li>)}
        </ul>
        <button type="button" onClick={onClose}>Done</button>
      </section>
    </div>
  );
}
