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
  hasOrgWideWrite,
  isOwnOrgCredential,
  ORG_WIDE_WRITE_WARNING,
  type AccessSubjects,
} from '../org-credential-access';
import { AccessFaces } from './AccessFaces';
import { AccessListEditor, OrgCredentialForm } from './OrgCredentialForm';
import { OrgCredentialImport } from './OrgCredentialImport';
import { PanelHeader } from './primitives';

function dateLabel(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The access list being edited in place, under the row it belongs to. One
 * at a time: the chevron that opens one closes whichever was open. */
type AccessDraft = { name: string; grants: OrgCredentialGrantView[] };

/**
 * One credential: the row, and — while its chevron is open — the access list
 * below it, in the same block.
 *
 * THE BLOCK IS WHY THE LIST'S OWN SEPARATOR MOVED. `.settings-credential-row`
 * draws its hairline from `:first-child`, and every row is now the first child
 * of its own block, so the line is drawn between blocks instead
 * (org-credentials.css). Expanding must not cost a row its separator.
 */
function CredentialBlock({
  credential,
  subjects,
  owner,
  canEdit,
  draft,
  saving,
  saveError,
  revoking,
  onToggleAccess,
  onDraftChange,
  onSaveAccess,
  onRotate,
  onRevoke,
}: {
  credential: OrgCredentialView;
  subjects: AccessSubjects;
  /** The creator, on the admin list only — see the panel's section split. */
  owner: string | null;
  canEdit: boolean;
  draft: AccessDraft | null;
  saving: boolean;
  saveError: string | null;
  revoking: string | null;
  onToggleAccess: () => void;
  onDraftChange: (grants: OrgCredentialGrantView[]) => void;
  onSaveAccess: () => void;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  const expanded = draft !== null;
  return (
    <div className="org-credential-block">
      <article className="settings-credential-row org-credential-row">
        <div>
          <div className="settings-credential-row__title">
            <h3><code>{credential.name}</code></h3>
          </div>
          {credential.comment !== null && <p>{credential.comment}</p>}
          <small>
            {owner === null ? dateLabel(credential.createdAt) : `added by ${owner} · ${dateLabel(credential.createdAt)}`}
          </small>
          {hasOrgWideWrite(credential.grants) && (
            <p className="org-access-warning">{ORG_WIDE_WRITE_WARNING}</p>
          )}
        </div>
        <AccessFaces
          credentialName={credential.name}
          grants={credential.grants}
          subjects={subjects}
          expanded={expanded}
          onToggle={onToggleAccess}
        />
        {canEdit && (
          <div className="settings-row-actions">
            <button
              className="webapp-action"
              type="button"
              aria-label={`Rotate ${credential.name}`}
              onClick={onRotate}
            >Rotate</button>
            <button
              className="webapp-action webapp-action--danger"
              type="button"
              aria-label={`Revoke ${credential.name}`}
              disabled={revoking !== null}
              onClick={onRevoke}
            >{revoking === credential.name ? 'Revoking…' : 'Revoke'}</button>
          </div>
        )}
      </article>
      {draft !== null && (
        <div className="org-credential-access" aria-label={`Access to ${credential.name}`}>
          <AccessListEditor grants={draft.grants} subjects={subjects} onChange={onDraftChange} />
          {saveError !== null && (
            <p className="webapp-form-message" role="alert">{saveError}</p>
          )}
          <div className="cfg-actions">
            <button
              className="webapp-action webapp-action--primary"
              type="button"
              disabled={saving}
              onClick={onSaveAccess}
            >{saving ? 'Saving…' : 'Save access'}</button>
            <button
              className="webapp-action"
              type="button"
              disabled={saving}
              onClick={onToggleAccess}
            >Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Settings → Credentials (plans/ORG-CREDENTIALS.md §9): the org's static
 * secrets behind an explicit allowlist. Names and comments only — a value is
 * write-only and never comes back. Any active member may add one; the access
 * list is edited by its writers and by org admins.
 *
 * THE PANEL SPLITS BY WHO IS LOOKING. An admin reads the whole store, so one
 * list ("Stored") with the owner on every row is the true shape of what they
 * see. A member reads a handful, and the useful cut is whether their own name
 * is on it: "My credentials" are the ones they made or were named in,
 * "Shared credentials" are the ones a workspace or the org handed them
 * (`isOwnOrgCredential`). The add form stays under the first list, which is
 * the only one it can add to. */
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
  const [accessDraft, setAccessDraft] = useState<AccessDraft | null>(null);
  const [savingAccess, setSavingAccess] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
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

  const mine = useMemo(
    () => credentials.filter((credential) => isOwnOrgCredential(credential, viewer.membership.id)),
    [credentials, viewer.membership.id],
  );
  const shared = useMemo(
    () => credentials.filter((credential) => !isOwnOrgCredential(credential, viewer.membership.id)),
    [credentials, viewer.membership.id],
  );

  const put = async (input: PutOrgCredentialRequest) => {
    await client.putOrgCredential(input);
    setRotating(null);
    await reload();
  };

  const toggleAccess = (credential: OrgCredentialView) => {
    setAccessError(null);
    setAccessDraft((open) => open?.name === credential.name
      ? null
      : { name: credential.name, grants: [...credential.grants] });
  };

  const saveAccess = async () => {
    if (accessDraft === null || savingAccess) return;
    setSavingAccess(true);
    setAccessError(null);
    try {
      // The client method keeps the wire's name: the route it calls is
      // `.../grants`, and only what a member reads changed.
      await client.replaceOrgCredentialGrants(accessDraft.name, { grants: accessDraft.grants });
      setAccessDraft(null);
      await reload();
    } catch (caught) {
      setAccessError(caughtErrorMessage(caught, 'The access list was not saved.'));
    } finally {
      setSavingAccess(false);
    }
  };

  const revoke = async (credential: OrgCredentialView) => {
    if (revoking !== null) return;
    setRevoking(credential.name);
    setRevokeError(null);
    try {
      await client.revokeOrgCredential(credential.name);
      if (accessDraft?.name === credential.name) setAccessDraft(null);
      if (rotating === credential.name) setRotating(null);
      await reload();
      // THE DIALOG CLOSES ONLY ON SUCCESS. A failure draws inside it, beside
      // the button that caused it.
      setRevokeTarget(null);
    } catch (caught) {
      setRevokeError(caughtErrorMessage(caught, 'Revoke failed.'));
    } finally {
      setRevoking(null);
    }
  };

  /* Called, not mounted: the returned elements are inlined into this
     component's own tree, so a section keeps its identity across a render and
     the picker inside an expanded row keeps its focus. A component declared
     inside a render would be a new type on every keystroke. */
  const section = ({ title, list, empty, owners }: {
    title: string;
    list: OrgCredentialView[];
    empty: string;
    /** The creator on every row. The admin list only — see the panel note. */
    owners: boolean;
  }) => (
    <section className="cfg-section" aria-label={title}>
      <div className="settings-section-heading">
        <div className="cfg-section-head">
          <h2 className="cfg-title">{title}{list.length > 0 && ` · ${String(list.length)}`}</h2>
        </div>
      </div>
      {loading ? (
        <p className="settings-credential-state">Loading credentials…</p>
      ) : list.length === 0 ? (
        <p className="settings-credential-state">{empty}</p>
      ) : (
        <div className="settings-credential-list">
          {list.map((credential) => (
            <CredentialBlock
              key={credential.id}
              credential={credential}
              subjects={subjects}
              owner={owners ? creatorLabel(credential) : null}
              canEdit={canEdit(credential)}
              draft={accessDraft?.name === credential.name ? accessDraft : null}
              saving={savingAccess}
              saveError={accessDraft?.name === credential.name ? accessError : null}
              revoking={revoking}
              onToggleAccess={() => toggleAccess(credential)}
              onDraftChange={(grants) => setAccessDraft({ name: credential.name, grants })}
              onSaveAccess={() => { void saveAccess(); }}
              onRotate={() => setRotating(credential.name)}
              onRevoke={() => {
                setRevokeError(null);
                setRevokeTarget(credential);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );

  /* The form draws its own two cards and their headings, so it is mounted
     bare: a section around it would be a section around a section, and the
     settings surface draws one divider between two of those. */
  const form = (
    <OrgCredentialForm
      key={rotating ?? 'add'}
      mode={rotating === null ? { kind: 'add' } : { kind: 'rotate', name: rotating }}
      subjects={subjects}
      onSubmit={put}
      onCancel={rotating === null ? undefined : () => setRotating(null)}
    />
  );

  return (
    <section className="settings-panel settings-org-credentials" role="tabpanel" aria-label="Credentials">
      <PanelHeader
        eyebrow="Organization"
        title="Credentials"
      />
      {error && <p className="webapp-form-message" role="alert">{error}</p>}

      {admin ? (
        <>
          {section({ title: 'Stored', list: credentials, empty: 'No credentials yet.', owners: true })}
          {form}
        </>
      ) : (
        <>
          {section({ title: 'My credentials', list: mine, empty: 'No credentials yet.', owners: false })}
          {form}
          {/* The owner rides a SHARED row and not a mine row: "who gave me this"
              is the one fact a shared credential carries that its name does
              not, and on a key of the viewer's own it would only ever say
              "you". */}
          {section({ title: 'Shared credentials', list: shared, empty: 'Nothing shared with you.', owners: true })}
        </>
      )}

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
          busy={revoking === revokeTarget.name}
          error={revokeError}
          onCancel={() => {
            setRevokeError(null);
            setRevokeTarget(null);
          }}
          onConfirm={() => { void revoke(revokeTarget); }}
        />
      )}
    </section>
  );
}
