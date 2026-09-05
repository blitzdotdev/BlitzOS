import { OrgNameForm } from './OrgNameForm';

/** Onboarding: a session with no membership at all lands here. */
export function CreateOrgPage({
  name,
  onNameChange,
  onCreate,
}: {
  name: string;
  onNameChange: (name: string) => void;
  onCreate: (name: string) => Promise<void>;
}): React.JSX.Element {
  return (
    <main className="login-screen">
      <OrgNameForm
        submitLabel="Create"
        name={name}
        onNameChange={onNameChange}
        onCreate={onCreate}
      />
    </main>
  );
}
