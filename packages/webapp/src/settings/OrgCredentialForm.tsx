import type {
  OrgCredentialAccess,
  OrgCredentialGrantSubjectKind,
  OrgCredentialGrantView,
  PutOrgCredentialRequest,
} from '@blitzos/schema';
import { useState, type ReactNode } from 'react';
import { caughtErrorMessage } from '../error-message';
import {
  accessSubjectLabel,
  accessSubjectTag,
  hasOrgWideWrite,
  ORG_WIDE_WRITE_WARNING,
  type AccessSubjects,
} from '../org-credential-access';

/**
 * The one access-list editor (plans/ORG-CREDENTIALS.md §9): who may use this
 * credential, as a list of rows, with a `+` that reveals the picker.
 *
 * THE LIST IS THE SURFACE, AND THE PICKER IS A DETAIL OF ADDING TO IT. The
 * editor used to draw both at once — three selects and a button sitting under
 * every list, whether or not anybody was adding anyone — so the first thing a
 * member read was a form, and the answer to "who can use this key" was above
 * it in smaller type. The rows come first now and the picker appears on `+`.
 *
 * THE `+` AND THE PICKER ARE ROWS OF THE LIST, inside its card and separated
 * by the same hairline. Below the card they read as a second thing on the
 * screen; inside it, pressing `+` visibly turns the last row into the row
 * being added.
 *
 * The picker holds no state worth abandoning: nothing is recorded until Add
 * access is pressed, so it has no dismiss verb of its own.
 *
 * EVERYONE IN THE ORG IS A ROW TOO. It was a checkbox above the list, which
 * made the broadest audience of all the one thing the list did not mention.
 * It is a subject kind in the picker and a row like any other, with the same
 * read/write toggle and the same ×.
 *
 * The add form and the per-credential editor both draw this, so the audience
 * of a key is edited the same way everywhere.
 */
export function AccessListEditor({
  grants,
  subjects,
  onChange,
}: {
  /** The access list, in the wire's own shape (`OrgCredentialGrantView`). */
  grants: OrgCredentialGrantView[];
  subjects: AccessSubjects;
  onChange: (grants: OrgCredentialGrantView[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<OrgCredentialGrantSubjectKind>('workspace');
  const [subjectId, setSubjectId] = useState('');
  const [access, setAccess] = useState<OrgCredentialAccess>('read');

  const orgWide = grants.find((grant) => grant.subjectKind === 'org') ?? null;
  const candidates = kind === 'org'
    ? []
    : kind === 'workspace'
      ? subjects.workspaces.map(({ id, name }) => ({ id, label: name }))
      : subjects.members.map(({ id, name, email }) => ({
          id,
          label: id === subjects.viewerMembershipId ? 'You' : (name || email),
        }));
  const chosen = subjectId !== '' && candidates.some(({ id }) => id === subjectId)
    ? subjectId
    : (candidates[0]?.id ?? '');
  // Everyone-in-the-org names no subject, so it is addable whenever it is not
  // already on the list; every other kind needs somebody picked.
  const addable = kind === 'org' ? orgWide === null : chosen !== '';

  const replace = (
    subjectKind: OrgCredentialGrantSubjectKind,
    id: string | null,
    level: OrgCredentialAccess,
  ) => {
    const rest = grants.filter((grant) =>
      !(grant.subjectKind === subjectKind && grant.subjectId === id));
    onChange([...rest, { subjectKind, subjectId: id, access: level }]);
  };
  const remove = (grant: OrgCredentialGrantView) => {
    onChange(grants.filter((candidate) =>
      !(candidate.subjectKind === grant.subjectKind && candidate.subjectId === grant.subjectId)));
  };

  return (
    <div className="org-access-editor">
      <div className="org-access-rows">
        {grants.length === 0 && (
          <p className="org-access-empty">
            Nobody yet. Add a workspace, a member, or everyone in {subjects.orgName}.
          </p>
        )}
        {grants.map((grant) => {
          const label = accessSubjectLabel(grant, subjects);
          return (
            <div className="org-access-row" key={`${grant.subjectKind}:${grant.subjectId ?? ''}`}>
              <span className="org-access-subject">
                <em>{label}</em>
                <span className="machine-chip">{accessSubjectTag(grant.subjectKind)}</span>
              </span>
              <AccessToggle
                value={grant.access}
                label={grant.subjectKind === 'org' ? 'Org-wide access' : `Access for ${label}`}
                onChange={(level) => replace(grant.subjectKind, grant.subjectId, level)}
              />
              <button
                className="org-access-remove"
                type="button"
                aria-label={`Remove access for ${label}`}
                onClick={() => remove(grant)}
              >×</button>
            </div>
          );
        })}
        {adding ? (
          <div className="org-access-add">
            <label className="cfg-field cfg-field--compact">
              <span>Type</span>
              <select
                aria-label="Access subject kind"
                value={kind}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setKind(next === 'membership' ? 'membership' : next === 'org' ? 'org' : 'workspace');
                  setSubjectId('');
                }}
              >
                <option value="workspace">Workspace</option>
                <option value="membership">Member</option>
                <option value="org">Everyone in {subjects.orgName}</option>
              </select>
            </label>
            {kind !== 'org' && (
              <label className="cfg-field">
                <span>{kind === 'workspace' ? 'Workspace' : 'Member'}</span>
                <select
                  aria-label={kind === 'workspace' ? 'Access workspace' : 'Access member'}
                  value={chosen}
                  disabled={candidates.length === 0}
                  onChange={(event) => setSubjectId(event.currentTarget.value)}
                >
                  {candidates.length === 0 && <option value="">None available</option>}
                  {candidates.map(({ id, label }) => <option value={id} key={id}>{label}</option>)}
                </select>
              </label>
            )}
            <label className="cfg-field cfg-field--compact">
              <span>Access</span>
              <select
                aria-label="Access level"
                value={access}
                onChange={(event) =>
                  setAccess(event.currentTarget.value === 'write' ? 'write' : 'read')}
              >
                <option value="read">Read</option>
                <option value="write">Write</option>
              </select>
            </label>
            {/* NO CANCEL. The picker records nothing until Add access is
                pressed, so leaving it open costs a member nothing and a second
                dismiss verb beside the form's own Cancel would be the only thing
                here that could be misread as abandoning the credential. */}
            <button
              className="webapp-action"
              type="button"
              disabled={!addable}
              onClick={() => {
                if (!addable) return;
                replace(kind, kind === 'org' ? null : chosen, access);
                setSubjectId('');
                setAdding(false);
              }}
            >Add access</button>
          </div>
        ) : (
          <button
            className="org-access-open"
            type="button"
            aria-label="Add access"
            onClick={() => setAdding(true)}
          >+</button>
        )}
      </div>
      {hasOrgWideWrite(grants) && (
        <p className="org-access-warning" role="alert">{ORG_WIDE_WRITE_WARNING}</p>
      )}
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
   * comment and the access list stay as they are. */
  | { kind: 'rotate'; name: string };

/**
 * The org-level add / rotate form (plans/ORG-CREDENTIALS.md §9). The
 * Credentials panel and the workspace tab open the same one. A value is
 * write-only: the field never shows a stored one.
 *
 * ONE CARD, ONE HEADING, NO LINE THROUGH IT. Adding a credential is one act,
 * so it is one section: name, value, comment, and then who may use it as the
 * last field of the same column. The access list is boxed — a raised card
 * inside the field — which is what separates it from the three text inputs
 * above without a divider, because a divider here would say "second section"
 * about the back half of one form.
 *
 * The form OWNS its heading, so a surface embeds it directly rather than
 * wrapping it in a section of its own: the settings-surface rule is one
 * divider between two sections, and a section around a section draws two.
 *
 * A rotation drops the comment and the access list: it changes the secret,
 * and nothing about who reads it.
 */
export function OrgCredentialForm({
  mode,
  subjects,
  description,
  onSubmit,
  onCancel,
}: {
  mode: OrgCredentialFormMode;
  subjects: AccessSubjects;
  /** The sentence under the first card's heading. Each surface says something
   * different about where a key lands, so the surface supplies it. */
  description?: ReactNode;
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
      <div className="cfg-section">
        <div className="cfg-section-head">
          <h2 className="cfg-title">
            {mode.kind === 'add' ? 'Add a credential' : <>Rotate <code>{mode.name}</code></>}
          </h2>
          {description !== undefined && <p className="cfg-desc">{description}</p>}
        </div>
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
              {/* The count is on the label because the answer to "who may use
                  this" is a number before it is a list, and an empty list is
                  the one state a member must not miss. */}
              <span>Members with access{grants.length > 0 && ` · ${String(grants.length)}`}</span>
              <AccessListEditor grants={grants} subjects={subjects} onChange={setGrants} />
              <p className="cfg-help">You keep write access.</p>
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
      </div>
    </form>
  );
}
