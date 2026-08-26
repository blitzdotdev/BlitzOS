export function LoginForm({
  loginUrl,
}: {
  loginUrl: string;
}): React.JSX.Element {
  return (
    <main className="login-screen">
      <div className="card login-card">
        <p className="eyebrow">BlitzOS</p>
        <h1>Open webApp</h1>
        <a className="webapp-action webapp-action--primary" href={loginUrl}>
          Continue with Google
        </a>
        <p className="login-terms">
          By continuing you agree to the <a href="/terms">Terms</a>.
        </p>
      </div>
    </main>
  );
}
