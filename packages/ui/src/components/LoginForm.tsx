import { useState } from "react";
import { isString } from "../type-guards";

export function LoginForm({
  onLogin,
}: {
  onLogin: (operatorKey: string) => Promise<void>;
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    const form = event.currentTarget;
    const operatorKey = new FormData(form).get("operatorKey");
    if (!isString(operatorKey) || operatorKey.length === 0) return;
    form.reset();
    setSubmitting(true);
    setError(null);
    try {
      await onLogin(operatorKey);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Login failed.");
      setSubmitting(false);
    }
  };

  return (
    <main className="login-screen">
      <form className="card login-card" onSubmit={(event) => void submit(event)}>
        <p className="eyebrow">BlitzOS</p>
        <h1>Open cockpit</h1>
        <label htmlFor="operator-key">Operator key</label>
        <input id="operator-key" name="operatorKey" type="password" autoComplete="off" required />
        {error !== null && <p className="cockpit-form-message form-error">{error}</p>}
        <button className="cockpit-action cockpit-action--primary" type="submit" disabled={submitting}>
          {submitting && <span className="cockpit-inline-spinner" />}
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
