import { useState } from 'react';
import { caughtErrorMessage } from '../error-message';

/** The one org-name form. Onboarding frames it as a full page
 * (CreateOrgPage), the rail frames it as a dialog (CreateOrgDialog); the
 * field, the trim rule and the busy handling live here so the two frames
 * cannot drift apart. */
export function OrgNameForm({
  submitLabel,
  autoFocus = false,
  name,
  onNameChange,
  onCreate,
  children,
}: {
  submitLabel: string;
  autoFocus?: boolean;
  name: string;
  onNameChange: (name: string) => void;
  onCreate: (name: string) => Promise<void>;
  /** Extra controls beside the submit button, such as a dialog's Cancel. */
  children?: React.ReactNode;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const normalized = name.trim();
    if (normalized === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(normalized);
    } catch (cause) {
      setError(caughtErrorMessage(cause, 'Could not create the organization.'));
      setBusy(false);
    }
  };

  return (
    <form className="card login-card" onSubmit={(event) => void submit(event)}>
      <label htmlFor="organization-name">Organization name</label>
      <input
        id="organization-name"
        name="name"
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
        autoComplete="organization"
        autoFocus={autoFocus}
        required
      />
      {error !== null && <p className="webapp-form-message form-error">{error}</p>}
      <div className="create-org-actions">
        {children}
        <button className="webapp-action webapp-action--primary" type="submit" disabled={busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
