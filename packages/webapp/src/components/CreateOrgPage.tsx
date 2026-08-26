import { OrgNameForm } from './OrgNameForm';

/** Onboarding: a session with no membership at all lands here. */
export function CreateOrgPage({
  onCreate,
}: {
  onCreate: (name: string) => Promise<void>;
}): React.JSX.Element {
  return (
    <main className="login-screen">
      <OrgNameForm submitLabel="Create" onCreate={onCreate} />
    </main>
  );
}
