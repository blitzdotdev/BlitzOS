import type {
  OrgCredentialGrantView,
  OrgCredentialView,
  PutOrgCredentialRequest,
} from '@blitzos/schema';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ControlPlaneClient, MemberView } from '../api';
import type { TenantMe } from '../api-adapter';
import { ConfirmationDialog } from '../ConfirmationDialog';
import { caughtErrorMessage } from '../error-message';
import {
  grantSubjectLabel,
  grantSubjectTag,
  hasOrgWideWrite,
  ORG_WIDE_WRITE_WARNING,
  type GrantSubjects,
} from '../org-credential-grants';
import { GrantListEditor, OrgCredentialForm } from './OrgCredentialForm';
import { OrgCredentialImport } from './OrgCredentialImport';

function dateLabel(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The grant chips on a list row: one pill per receiver, kind and level in
 * words. Empty for a plain reader, whose wire view carries no audience. */
export function GrantChips({
  grants,
  subjects,
}: {
  grants: ReadonlyArray<OrgCredentialGrantView>;
  subjects: GrantSubjects;
}) {
  if (grants.length === 0) return null;
  return (
    <div className="org-grant-chips" aria-label="Grants">
      {grants.map((grant) => (
        <span className="machine-chip org-grant-chip" key={`${grant.subjectKind}:${grant.subjectId ?? ''}`}>
          {grantSubjectTag(grant.subjectKind)} {grantSubjectLabel(grant, subjects)} · {grant.access}
        </span>
      ))}
    </div>
  );
}

/** Settings → Credentials (plans/ORG-CREDENTIALS.md §9): the org's static
 * secrets behind an explicit allowlist. Names and comments only — a value is
 * write-only and never comes back. Any active member may add one; the grant
 * set is edited by its writers and by org admins. */
export function OrgCredentialsPanel({
  client,
  viewer,
}: {
  client: ControlPlaneClient;
  viewer: TenantMe;
}) {
  const [credentials, setCredentials] = useState<OrgCredentialView[]>([]);
  const [members, setMembers] = useState<MemberView[]>([]);
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rotating, setRotating] = useState<string | null>(null);
  const [grantsEditor, setGrantsEditor] = useState<{ name: string; grants: OrgCredentialGrantView[] } | null>(null);
  const [savingGrants, setSavingGrants] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<OrgCredentialView | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const admin = viewer.membership.role === 'admin';

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const listed = await client.listOrgCredentials(signal);
      if (signal?.aborted) return;
      setCredentials(listed.credentials);
      setError(null);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(caughtErrorMessage(caught, 'Credentials failed to load.'));
    } finally {
      if (signal?.aborted !== true) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    const abort = new AbortController();
    void reload(abort.signal);
    // The subject picker's vocabulary: every workspace the viewer can see and
    // every active member. Either failing leaves ids where names would be.
    void client.listMembers()
      .then((response) => { if (!abort.signal.aborted) setMembers(response.members); })
      .catch(() => undefined);
    void client.poll(abort.signal)
      .then((response) => {
        if (abort.signal.aborted) return;
        setWorkspaces(response.workspaces.map(({ id, name }) => ({ id, name })));
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [client, reload]);

  const subjects = useMemo<GrantSubjects>(() => ({
    orgName: viewer.org.name || viewer.org.slug,
    viewerMembershipId: viewer.membership.id,
    workspaces,
    members: members.filter((member) => member.status === 'active'),
  }), [members, viewer, workspaces]);

  const creatorLabel = (credential: OrgCredentialView): string => {
    if (credential.createdByMembershipId === viewer.membership.id) return 'you';
    const member = members.find(({ id }) => id === credential.createdByMembershipId);
    return member === undefined ? 'a member' : (member.name || member.email);
  };

  /** The wire sends the full grant set to writers and admins and `[]` to
   * plain readers, so a visible audience is the edit permission. */
  const canEdit = (credential: OrgCredentialView) => admin || credential.grants.length > 0;

  const put = async (input: PutOrgCredentialRequest) => {
    await client.putOrgCredential(input);
    setRotating(null);
    await reload();
  };

  const saveGrants = async () => {
    if (grantsEditor === null || savingGrants) return;
    setSavingGrants(true);
    setError(null);
    try {
      await client.replaceOrgCredentialGrants(grantsEditor.name, { grants: grantsEditor.grants });
      setGrantsEditor(null);
      await reload();
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'The grants were not saved.'));
    } finally {
      setSavingGrants(false);
    }
  };

  const revoke = async (credential: OrgCredentialView) => {
    if (revoking !== null) return;
    setRevokeTarget(null);
    setRevoking(credential.name);
    setError(null);
    try {
      await client.revokeOrgCredential(credential.name);
      if (grantsEditor?.name === credential.name) setGrantsEditor(null);
      if (rotating === credential.name) setRotating(null);
      await reload();
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Revoke failed.'));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section className="settings-panel settings-org-credentials" role="tabpanel" aria-label="Credentials">
      <header className="settings-panel-header">
        <div>
          <p>Organization</p>
          <h1>Credentials</h1>
          <span>Static secrets agents pull at the moment of use. Each one reaches exactly who it is granted to.</span>
        </div>
      </header>
      {error && <p className="webapp-form-message" role="alert">{error}</p>}

      <section className="cfg-section" aria-label="Stored credentials">
        <div className="settings-section-heading">
          <div className="cfg-section-head">
            <h2 className="cfg-title">Stored</h2>
            <p className="cfg-desc">Names and comments only. A value never comes back out.</p>
          </div>
          {credentials.length > 0 && <span>{credentials.length} total</span>}
        </div>
        {loading ? (
          <p className="settings-credential-state">Loading credentials…</p>
        ) : credentials.length === 0 ? (
          <p className="settings-credential-state">
            No credentials yet. Add one below, or import a .env file.
          </p>
        ) : (
          <div className="settings-credential-list">
            {credentials.map((credential) => (
              <article className="settings-credential-row org-credential-row" key={credential.id}>
                <div>
                  <div className="settings-credential-row__title">
                    <h3><code>{credential.name}</code></h3>
                  </div>
                  {credential.comment !== null && <p>{credential.comment}</p>}
                  <small>added by {creatorLabel(credential)} · {dateLabel(credential.createdAt)}</small>
                  <GrantChips grants={credential.grants} subjects={subjects} />
                  {hasOrgWideWrite(credential.grants) && (
                    <p className="org-grants-warning">{ORG_WIDE_WRITE_WARNING}</p>
                  )}
                </div>
                {canEdit(credential) && (
                  <div className="settings-row-actions">
                    <button
                      className="webapp-action"
                      type="button"
                      aria-label={`Edit grants for ${credential.name}`}
                      onClick={() => setGrantsEditor({ name: credential.name, grants: [...credential.grants] })}
                    >Grants</button>
                    <button
                      className="webapp-action"
                      type="button"
                      aria-label={`Rotate ${credential.name}`}
                      onClick={() => setRotating(credential.name)}
                    >Rotate</button>
                    <button
                      className="webapp-action webapp-action--danger"
                      type="button"
                      aria-label={`Revoke ${credential.name}`}
                      disabled={revoking !== null}
                      onClick={() => setRevokeTarget(credential)}
                    >{revoking === credential.name ? 'Revoking…' : 'Revoke'}</button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {grantsEditor !== null && (
        <section className="cfg-section" aria-label={`Grants for ${grantsEditor.name}`}>
          <div className="cfg-section-head">
            <h2 className="cfg-title">Grants for <code>{grantsEditor.name}</code></h2>
            <p className="cfg-desc">What is saved is the whole audience: every receiver listed here, and no one else.</p>
          </div>
          <GrantListEditor
            grants={grantsEditor.grants}
            subjects={subjects}
            onChange={(grants) => setGrantsEditor({ name: grantsEditor.name, grants })}
          />
          <div className="cfg-actions">
            <button
              className="webapp-action webapp-action--primary"
              type="button"
              disabled={savingGrants}
              onClick={() => { void saveGrants(); }}
            >{savingGrants ? 'Saving…' : 'Save grants'}</button>
            <button
              className="webapp-action"
              type="button"
              disabled={savingGrants}
              onClick={() => setGrantsEditor(null)}
            >Cancel</button>
          </div>
        </section>
      )}

      <section className="cfg-section" aria-label={rotating === null ? 'Add a credential' : `Rotate ${rotating}`}>
        <div className="cfg-section-head">
          <h2 className="cfg-title">{rotating === null ? 'Add a credential' : <>Rotate <code>{rotating}</code></>}</h2>
          <p className="cfg-desc">
            {rotating === null
              ? 'One name, one value. Agents read the comment, so say what the key is for.'
              : 'The new value replaces the old one on the next pull. The comment and the grants stay.'}
          </p>
        </div>
        <OrgCredentialForm
          key={rotating ?? 'add'}
          mode={rotating === null ? { kind: 'add' } : { kind: 'rotate', name: rotating }}
          subjects={subjects}
          onSubmit={put}
          onCancel={rotating === null ? undefined : () => setRotating(null)}
        />
      </section>

      <section className="cfg-section" aria-label="Import a .env file">
        <OrgCredentialImport
          onImport={client.importOrgCredentials}
          onImported={() => { void reload(); }}
        />
      </section>

      {revokeTarget && (
        <ConfirmationDialog
          title="Revoke this credential?"
          description={`Revoke ${revokeTarget.name} for the whole organization? Every machine that pulls it is refused on the next ask.`}
          confirmLabel="Revoke credential"
          onCancel={() => setRevokeTarget(null)}
          onConfirm={() => { void revoke(revokeTarget); }}
        />
      )}
    </section>
  );
}
