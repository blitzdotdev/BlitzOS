import type { OrgCredentialView, PutOrgCredentialRequest } from '@blitzos/schema';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ControlPlaneClient, MemberView } from './api';
import { caughtErrorMessage } from './error-message';
import {
  workspaceReadPath,
  type GrantSubjects,
  type WorkspaceReadPath,
} from './org-credential-grants';
import { OrgCredentialForm } from './settings/OrgCredentialForm';

const PATH_LABELS = {
  workspace: 'granted to this workspace',
  org: 'org-wide',
  membership: 'granted to you',
  unknown: 'readable by you',
} satisfies Record<WorkspaceReadPath, string>;

/** The workspace's Credentials tab (plans/ORG-CREDENTIALS.md §9): a filtered
 * view over ORG credentials — the ones readable in this workspace through a
 * workspace grant, an org-wide grant, or the viewer's own membership grant.
 * There is no workspace store behind it: add and rotate open the org-level
 * form, and a new key is granted to this workspace by default. */
export function WorkspaceCredentialsTab({
  client,
  workspaceId,
  workspaceName,
  orgName,
  viewerMembershipId,
  orgMembers,
  workspaces,
}: {
  client: Pick<ControlPlaneClient, 'listOrgCredentials' | 'putOrgCredential'>;
  workspaceId: string;
  workspaceName: string;
  orgName: string;
  viewerMembershipId: string | null;
  orgMembers: MemberView[];
  /** The org's workspaces, for the grant picker; at least this one. */
  workspaces: ReadonlyArray<{ id: string; name: string }>;
}) {
  const [credentials, setCredentials] = useState<OrgCredentialView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ kind: 'add' } | { kind: 'rotate'; name: string } | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const listed = await client.listOrgCredentials(signal, workspaceId);
      if (signal?.aborted) return;
      setCredentials(listed.credentials);
      setError(null);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(caughtErrorMessage(caught, 'Credentials failed to load.'));
    } finally {
      if (signal?.aborted !== true) setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    const abort = new AbortController();
    void reload(abort.signal);
    return () => abort.abort();
  }, [reload]);

  const subjects = useMemo<GrantSubjects>(() => ({
    orgName,
    viewerMembershipId,
    workspaces: workspaces.some(({ id }) => id === workspaceId)
      ? workspaces
      : [{ id: workspaceId, name: workspaceName }, ...workspaces],
    members: orgMembers.filter((member) => member.status === 'active'),
  }), [orgMembers, orgName, viewerMembershipId, workspaceId, workspaceName, workspaces]);

  const visible = credentials.map((credential) => (
    { credential, path: workspaceReadPath(credential, workspaceId, viewerMembershipId) }));

  const put = async (input: PutOrgCredentialRequest) => {
    await client.putOrgCredential(input);
    setForm(null);
    await reload();
  };

  return (
    <section
      id="workspace-details-credentials-panel"
      role="tabpanel"
      aria-label="Credentials"
      className="workspace-details-credentials"
    >
      <div className="cfg-section">
        <div className="cfg-section-head">
          <h2 className="cfg-title">Credentials in this workspace</h2>
          <p className="cfg-desc">
            Organization credentials readable here. Agents pull a value at the
            moment of use; nothing is stored on a machine.
          </p>
        </div>
        {error !== null && <p className="workspace-details-error" role="alert">{error}</p>}
        <div className="workspace-credential-rows">
          {loading && <p className="workspace-members-empty" role="status">Loading credentials…</p>}
          {!loading && visible.length === 0 && (
            <p className="workspace-members-empty">No organization credential reaches this workspace yet.</p>
          )}
          {visible.map(({ credential, path }) => (
            <div className="workspace-credential-row" key={credential.id}>
              <span className="workspace-credential-name">
                <strong><code>{credential.name}</code></strong>
                {credential.comment !== null && <small>{credential.comment}</small>}
              </span>
              <span className="workspace-credential-added">{PATH_LABELS[path]}</span>
              {credential.grants.length > 0 ? (
                <button
                  className="webapp-action"
                  type="button"
                  aria-label={`Rotate ${credential.name}`}
                  onClick={() => setForm({ kind: 'rotate', name: credential.name })}
                >Rotate</button>
              ) : <span />}
            </div>
          ))}
        </div>
        {form === null && (
          <div className="cfg-actions">
            <button
              className="webapp-action"
              type="button"
              onClick={() => setForm({ kind: 'add' })}
            >Add a credential</button>
          </div>
        )}
      </div>
      {form !== null && (
        <div className="cfg-section">
          <div className="cfg-section-head">
            <h2 className="cfg-title">
              {form.kind === 'add' ? 'Add a credential' : <>Rotate <code>{form.name}</code></>}
            </h2>
            <p className="cfg-desc">
              {form.kind === 'add'
                ? 'Stored at organization level and granted to this workspace. Widen the audience from Settings → Credentials.'
                : 'The new value replaces the old one on the next pull, in every workspace that reads it.'}
            </p>
          </div>
          <OrgCredentialForm
            key={form.kind === 'add' ? 'add' : form.name}
            mode={form.kind === 'add'
              ? { kind: 'add', initialGrants: [{ subjectKind: 'workspace', subjectId: workspaceId, access: 'read' }] }
              : form}
            subjects={subjects}
            onSubmit={put}
            onCancel={() => setForm(null)}
          />
        </div>
      )}
    </section>
  );
}
