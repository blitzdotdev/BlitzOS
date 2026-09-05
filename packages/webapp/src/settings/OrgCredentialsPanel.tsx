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
  accessSubjectLabel,
  accessSubjectTag,
  hasOrgWideWrite,
  ORG_WIDE_WRITE_WARNING,
  type AccessSubjects,
} from '../org-credential-access';
import { AccessListEditor, OrgCredentialForm } from './OrgCredentialForm';
import { OrgCredentialImport } from './OrgCredentialImport';
import { PanelHeader } from './primitives';

function dateLabel(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The access chips on a list row: one pill per subject, kind and level in
 * words. Empty for a plain reader, whose wire view carries no audience. */
export function AccessChips({
  grants,
  subjects,
}: {
  grants: ReadonlyArray<OrgCredentialGrantView>;
  subjects: AccessSubjects;
}) {
  if (grants.length === 0) return null;
  return (
    <div className="org-access-chips" aria-label="Access">
      {grants.map((grant) => (
        <span className="machine-chip org-access-chip" key={`${grant.subjectKind}:${grant.subjectId ?? ''}`}>
          {accessSubjectTag(grant.subjectKind)} {accessSubjectLabel(grant, subjects)} · {grant.access}
        </span>
      ))}
    </div>
  );
}

/** Settings → Credentials (plans/ORG-CREDENTIALS.md §9): the org's static
 * secrets behind an explicit allowlist. Names and comments only — a value is
 * write-only and never comes back. Any active member may add one; the access
 * list is edited by its writers and by org admins. */
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
  const [accessEditor, setAccessEditor] = useState<{ name: string; grants: OrgCredentialGrantView[] } | null>(null);
  const [savingAccess, setSavingAccess] = useState(false);
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

  const subjects = useMemo<AccessSubjects>(() => ({
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

  /** The wire sends the full access list to writers and admins and `[]` to
   * plain readers, so a visible audience is the edit permission. */
  const canEdit = (credential: OrgCredentialView) => admin || credential.grants.length > 0;

  const put = async (input: PutOrgCredentialRequest) => {
    await client.putOrgCredential(input);
    setRotating(null);
    await reload();
  };

  const saveAccess = async () => {
    if (accessEditor === null || savingAccess) return;
    setSavingAccess(true);
    setError(null);
    try {
      // The client method keeps the wire's name: the route it calls is
      // `.../grants`, and only what a member reads changed.
      await client.replaceOrgCredentialGrants(accessEditor.name, { grants: accessEditor.grants });
      setAccessEditor(null);
      await reload();
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'The access list was not saved.'));
    } finally {
      setSavingAccess(false);
    }
  };

  const revoke = async (credential: OrgCredentialView) => {
    if (revoking !== null) return;
    setRevokeTarget(null);
    setRevoking(credential.name);
    setError(null);
    try {
      await client.revokeOrgCredential(credential.name);
      if (accessEditor?.name === credential.name) setAccessEditor(null);
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
      <PanelHeader
        eyebrow="Organization"
        title="Credentials"
      />
      {error && <p className="webapp-form-message" role="alert">{error}</p>}

      <section className="cfg-section" aria-label="Stored credentials">
        <div className="settings-section-heading">
          <div className="cfg-section-head">
            <h2 className="cfg-title">
              Stored{credentials.length > 0 && ` · ${String(credentials.length)}`}
            </h2>
          </div>
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
                  <AccessChips grants={credential.grants} subjects={subjects} />
                  {hasOrgWideWrite(credential.grants) && (
                    <p className="org-access-warning">{ORG_WIDE_WRITE_WARNING}</p>
                  )}
                </div>
                {canEdit(credential) && (
                  <div className="settings-row-actions">
                    <button
                      className="webapp-action"
                      type="button"
                      aria-label={`Edit access for ${credential.name}`}
                      onClick={() => setAccessEditor({ name: credential.name, grants: [...credential.grants] })}
                    >Access</button>
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

      {accessEditor !== null && (
        <section className="cfg-section" aria-label={`Access to ${accessEditor.name}`}>
          <div className="cfg-section-head">
            <h2 className="cfg-title">Access to <code>{accessEditor.name}</code></h2>
          </div>
          <AccessListEditor
            grants={accessEditor.grants}
            subjects={subjects}
            onChange={(grants) => setAccessEditor({ name: accessEditor.name, grants })}
          />
          <div className="cfg-actions">
            <button
              className="webapp-action webapp-action--primary"
              type="button"
              disabled={savingAccess}
              onClick={() => { void saveAccess(); }}
            >{savingAccess ? 'Saving…' : 'Save access'}</button>
            <button
              className="webapp-action"
              type="button"
              disabled={savingAccess}
              onClick={() => setAccessEditor(null)}
            >Cancel</button>
          </div>
        </section>
      )}

      {/* The form draws its own two cards and their headings, so it is mounted
          bare: a section around it would be a section around a section, and
          the settings surface draws one divider between two of those. */}
      <OrgCredentialForm
        key={rotating ?? 'add'}
        mode={rotating === null ? { kind: 'add' } : { kind: 'rotate', name: rotating }}
        subjects={subjects}
        onSubmit={put}
        onCancel={rotating === null ? undefined : () => setRotating(null)}
      />

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
