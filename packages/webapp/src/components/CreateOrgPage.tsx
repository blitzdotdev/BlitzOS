import { useState } from 'react';
import { caughtErrorMessage } from '../error-message';

export function CreateOrgPage({
  onCreate,
}: {
  onCreate: (name: string) => Promise<void>;
}): React.JSX.Element {
  const [name, setName] = useState('');
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
    <main className="login-screen">
      <form className="card login-card" onSubmit={(event) => void submit(event)}>
        <label htmlFor="organization-name">Organization name</label>
        <input
          id="organization-name"
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="organization"
          required
        />
        {error !== null && <p className="webapp-form-message form-error">{error}</p>}
        <button className="webapp-action webapp-action--primary" type="submit" disabled={busy}>
          Create
        </button>
      </form>
    </main>
  );
}
