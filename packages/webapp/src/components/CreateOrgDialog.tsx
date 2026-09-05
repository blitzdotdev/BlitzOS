import { ModalOverlay } from '../ModalOverlay';
import { OrgNameForm } from './OrgNameForm';

/** The same org-name form the onboarding page shows, reached from the rail's
 * organization menu by someone who already belongs to one. */
export function CreateOrgDialog({
  name,
  onNameChange,
  onCreate,
  onCancel,
}: {
  name: string;
  onNameChange: (name: string) => void;
  onCreate: (name: string) => Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <ModalOverlay onDismiss={onCancel}>
      <div className="create-org-dialog" role="dialog" aria-modal="true" aria-label="Create organization">
        <h2>Create organization</h2>
        <p>You become its admin, and the app switches to it.</p>
        <OrgNameForm
          submitLabel="Create"
          autoFocus
          name={name}
          onNameChange={onNameChange}
          onCreate={onCreate}
        >
          <button className="webapp-action" type="button" onClick={onCancel}>Cancel</button>
        </OrgNameForm>
      </div>
    </ModalOverlay>
  );
}
