import { ConfirmationDialog } from './ConfirmationDialog';
import type { FileActionConfirmation } from './use-files-actions';

export function FilesActionConfirmation({
  confirmation,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  confirmation: FileActionConfirmation;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const targetKind = confirmation.target.kind === 'directory' ? 'folder' : 'file';
  const description = confirmation.action === 'rename'
    ? confirmation.dirtyCount === 1
      ? `“${confirmation.target.name}” contains an open file with unsaved changes. Rename it and keep those changes in the editor at the new path?`
      : `“${confirmation.target.name}” contains ${confirmation.dirtyCount} open files with unsaved changes. Rename it and keep those changes in their editors at the new paths?`
    : confirmation.dirtyCount > 0
      ? `Delete “${confirmation.target.name}” and discard unsaved changes in ${confirmation.dirtyCount} open ${confirmation.dirtyCount === 1 ? 'file' : 'files'}? This cannot be undone.`
      : confirmation.target.kind === 'directory'
        ? `Delete “${confirmation.target.name}” and everything inside it? This cannot be undone.`
        : `Delete “${confirmation.target.name}”? This cannot be undone.`;
  const label = confirmation.action === 'rename' ? 'Rename' : 'Delete';
  return (
    <ConfirmationDialog
      title={`${label} ${targetKind}?`}
      description={description}
      confirmLabel={label}
      cancelLabel="Cancel"
      busy={busy}
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
