import type {
  OrgCredentialAccess,
  OrgCredentialGrantSubjectKind,
  OrgCredentialGrantView,
  PutOrgCredentialRequest,
} from '@blitzos/schema';
import { useState } from 'react';
import { caughtErrorMessage } from '../error-message';
import {
  grantSubjectLabel,
  grantSubjectTag,
  hasOrgWideWrite,
  ORG_WIDE_WRITE_WARNING,
  type GrantSubjects,
} from '../org-credential-grants';

/** The one grant-set editor (plans/ORG-CREDENTIALS.md §9): a subject picker
 * over the org's workspaces and active members, an org-wide toggle, and
 * read/write per row. The add form and the per-credential grants editor
 * both draw it, so the audience of a key is edited the same way everywhere. */
export function GrantListEditor({
  grants,
  subjects,
  onChange,
}: {
  grants: OrgCredentialGrantView[];
  subjects: GrantSubjects;
  onChange: (grants: OrgCredentialGrantView[]) => void;
}) {
  const [kind, setKind] = useState<Exclude<OrgCredentialGrantSubjectKind, 'org'>>('workspace');
  const [subjectId, setSubjectId] = useState('');
  const [access, setAccess] = useState<OrgCredentialAccess>('read');

  const orgWide = grants.find((grant) => grant.subjectKind === 'org') ?? null;
  const candidates = kind === 'workspace'
    ? subjects.workspaces.map(({ id, name }) => ({ id, label: name }))
    : subjects.members.map(({ id, name, email }) => ({
        id,
        label: id === subjects.viewerMembershipId ? 'You' : (name || email),
      }));
  const chosen = subjectId !== '' && candidates.some(({ id }) => id === subjectId)
    ? subjectId
    : (candidates[0]?.id ?? '');

  const replace = (subjectKind: OrgCredentialGrantSubjectKind, id: string | null, level: OrgCredentialAccess) => {
    const rest = grants.filter((grant) =>
      !(grant.subjectKind === subjectKind && grant.subjectId === id));
    onChange([...rest, { subjectKind, subjectId: id, access: level }]);
  };
  const remove = (grant: OrgCredentialGrantView) => {
    onChange(grants.filter((candidate) =>
      !(candidate.subjectKind === grant.subjectKind && candidate.subjectId === grant.subjectId)));
  };

  return (
    <div className="org-grants-editor">
      <label className="cfg-field cfg-field--inline">
        <input
          type="checkbox"
          checked={orgWide !== null}
          onChange={(event) => {
            if (event.currentTarget.checked) replace('org', null, 'read');
            else onChange(grants.filter((grant) => grant.subjectKind !== 'org'));
          }}
        />
        <span>Everyone in {subjects.orgName}</span>
      </label>
      {orgWide !== null && (
        <div className="org-grants-orgwide">
          <AccessToggle
            value={orgWide.access}
            label="Org-wide access"
            onChange={(level) => replace('org', null, level)}
          />
          {hasOrgWideWrite(grants) && (
            <p className="org-grants-warning" role="alert">{ORG_WIDE_WRITE_WARNING}</p>
          )}
        </div>
      )}
      <div className="org-grants-rows">
        {grants.filter((grant) => grant.subjectKind !== 'org').map((grant) => (
          <div className="org-grant-row" key={`${grant.subjectKind}:${grant.subjectId ?? ''}`}>
            <span className="org-grant-subject">
              <em>{grantSubjectLabel(grant, subjects)}</em>
              <span className="machine-chip">{grantSubjectTag(grant.subjectKind)}</span>
            </span>
            <AccessToggle
              value={grant.access}
              label={`Access for ${grantSubjectLabel(grant, subjects)}`}
              onChange={(level) => replace(grant.subjectKind, grant.subjectId, level)}
            />
            <button
              className="org-grant-remove"
              type="button"
              aria-label={`Remove grant for ${grantSubjectLabel(grant, subjects)}`}
              onClick={() => remove(grant)}
            >×</button>
          </div>
        ))}
      </div>
      <div className="org-grants-add">
        <label className="cfg-field cfg-field--compact">
          <span>Grant to</span>
          <select
            aria-label="Grant subject kind"
            value={kind}
            onChange={(event) => {
              setKind(event.currentTarget.value === 'membership' ? 'membership' : 'workspace');
              setSubjectId('');
            }}
          >
            <option value="workspace">Workspace</option>
            <option value="membership">Member</option>
          </select>
        </label>
        <label className="cfg-field">
          <span>{kind === 'workspace' ? 'Workspace' : 'Member'}</span>
          <select
            aria-label={kind === 'workspace' ? 'Grant workspace' : 'Grant member'}
            value={chosen}
            disabled={candidates.length === 0}
            onChange={(event) => setSubjectId(event.currentTarget.value)}
          >
            {candidates.length === 0 && <option value="">None available</option>}
            {candidates.map(({ id, label }) => <option value={id} key={id}>{label}</option>)}
          </select>
        </label>
        <label className="cfg-field cfg-field--compact">
          <span>Access</span>
          <select
            aria-label="Grant access"
            value={access}
            onChange={(event) => setAccess(event.currentTarget.value === 'write' ? 'write' : 'read')}
          >
            <option value="read">Read</option>
            <option value="write">Write</option>
          </select>
        </label>
        <button
          className="webapp-action"
          type="button"
          disabled={chosen === ''}
          onClick={() => {
            if (chosen === '') return;
            replace(kind, chosen, access);
            setSubjectId('');
          }}
        >Add grant</button>
      </div>
    </div>
  );
}

/** Read or write, as the mock's segmented control. */
export function AccessToggle({
  value,
  label,
  onChange,
}: {
  value: OrgCredentialAccess;
  label: string;
  onChange: (access: OrgCredentialAccess) => void;
}) {
  return (
    <span className="org-access-toggle" role="group" aria-label={label}>
      {(['read', 'write'] as const).map((level) => (
        <button
          type="button"
          key={level}
          className={level === value ? 'on' : ''}
          aria-pressed={level === value}
          onClick={() => onChange(level)}
        >{level}</button>
      ))}
    </span>
  );
}

export type OrgCredentialFormMode =
  /** A new credential: name, value, comment, and who may use it. */
  | { kind: 'add'; initialGrants?: OrgCredentialGrantView[] }
  /** A rotation: the name is fixed and the value is all that changes. The
   * comment and the grant set stay as they are. */
  | { kind: 'rotate'; name: string };

/** The org-level add / rotate form (plans/ORG-CREDENTIALS.md §9). The
 * Credentials panel and the workspace tab open the same one. A value is
 * write-only: the field never shows a stored one. */
export function OrgCredentialForm({
  mode,
  subjects,
  onSubmit,
  onCancel,
}: {
  mode: OrgCredentialFormMode;
  subjects: GrantSubjects;
  onSubmit: (input: PutOrgCredentialRequest) => Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(mode.kind === 'rotate' ? mode.name : '');
  const [value, setValue] = useState('');
  const [comment, setComment] = useState('');
  const [grants, setGrants] = useState<OrgCredentialGrantView[]>(
    mode.kind === 'add' ? (mode.initialGrants ?? []) : [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (name.trim() === '' || value === '' || busy) return;
    const input: PutOrgCredentialRequest = { name: name.trim(), value };
    if (mode.kind === 'add') {
      // Absent keeps a comment; the field left empty is absence, not a clear.
      if (comment.trim() !== '') input.comment = comment.trim();
      input.grants = grants;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(input);
      setName(mode.kind === 'rotate' ? mode.name : '');
      setValue('');
      setComment('');
      setGrants([]);
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'The credential was not saved.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="org-credential-form"
      aria-label={mode.kind === 'add' ? 'Add a credential' : `Rotate ${mode.name}`}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      <label className="cfg-field">
        <span>Name</span>
        <input
          aria-label="Credential name"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="STRIPE_API_KEY"
          value={name}
          readOnly={mode.kind === 'rotate'}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label className="cfg-field">
        <span>{mode.kind === 'rotate' ? 'New value' : 'Value'}</span>
        <input
          aria-label="Credential value"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </label>
      {mode.kind === 'add' && (
        <>
          <label className="cfg-field">
            <span>Comment (optional)</span>
            <input
              aria-label="Credential comment"
              placeholder="what this key is for — agents read this"
              value={comment}
              onChange={(event) => setComment(event.currentTarget.value)}
            />
          </label>
          <div className="cfg-field">
            <span>Who may use it</span>
            <GrantListEditor grants={grants} subjects={subjects} onChange={setGrants} />
            <p className="cfg-help">You keep write access to a key you create.</p>
          </div>
        </>
      )}
      {error !== null && <p className="webapp-form-message" role="alert">{error}</p>}
      <div className="cfg-actions">
        <button
          className="webapp-action webapp-action--primary"
          type="submit"
          disabled={busy || name.trim() === '' || value === ''}
        >
          {mode.kind === 'add' ? 'Save credential' : 'Rotate'}
        </button>
        {onCancel !== undefined && (
          <button className="webapp-action" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
