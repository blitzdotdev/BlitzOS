import type { CreateWorkspaceRequest, MachineType, Volume } from '@blitzos/schema';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { OutlinedLoadingRows } from './LoadingSkeleton';
import { MachineCatalogGrid } from './MachineCatalogGrid';

export type CreateWorkspaceDialogInput = CreateWorkspaceRequest;

type CreateWorkspaceDialogProps = {
  busy: boolean;
  error: string | null;
  listMachineTypes: () => Promise<MachineType[]>;
  listVolumes: () => Promise<Volume[]>;
  onCancel: () => void;
  onSubmit: (input: CreateWorkspaceDialogInput) => void;
};

export function CreateWorkspaceDialog({
  busy,
  error,
  listMachineTypes,
  listVolumes,
  onCancel,
  onSubmit,
}: CreateWorkspaceDialogProps) {
  const [machines, setMachines] = useState<MachineType[]>([]);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [selectedMachineType, setSelectedMachineType] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const submitted = useRef(false);
  const selectedMachine = machines.find(({ id }) => id === selectedMachineType);
  const supportsVolumes = selectedMachine?.supportsVolumes ?? false;

  useEffect(() => {
    if (!busy) submitted.current = false;
  }, [busy]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setLoadError(null);
    void Promise.allSettled([listMachineTypes(), listVolumes()]).then(([machineResult, volumeResult]) => {
      if (!mounted) return;
      if (machineResult.status === 'rejected') {
        setLoadError(machineResult.reason instanceof Error
          ? machineResult.reason.message
          : 'Machine types could not be loaded.');
        setLoading(false);
        return;
      }
      setMachines(machineResult.value);
      setSelectedMachineType((current) => current || machineResult.value[0]?.id || '');
      setVolumes(volumeResult.status === 'fulfilled' ? volumeResult.value : []);
      setLoading(false);
    });
    return () => { mounted = false; };
  }, [listMachineTypes, listVolumes]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || submitted.current || selectedMachineType === '') return;
    const data = new FormData(event.currentTarget);
    const sshPublicKey = String(data.get('sshPublicKey') ?? '').trim();
    const volumeId = String(data.get('volumeId') ?? '');
    submitted.current = true;
    const input: CreateWorkspaceDialogInput = {
      machineTypeId: selectedMachineType,
    };
    if (sshPublicKey) input.sshPublicKey = sshPublicKey;
    if (volumeId) input.volumeId = volumeId;
    onSubmit(input);
  };

  return (
    <div className="create-workspace-screen" role="presentation">
      <form
        className="create-workspace-dialog"
        aria-label="Create workspace"
        onSubmit={submit}
      >
        <header className="create-workspace-header">
          <div className="create-workspace-header__title"><h1>Create workspace</h1></div>
          <button type="button" aria-label="Close" disabled={busy} onClick={onCancel}>×</button>
        </header>

        <div className="create-workspace-main">
          {(error || loadError) && (
            <div className="create-workspace-notices">
              <p className="cockpit-form-message" role="alert">{error ?? loadError}</p>
            </div>
          )}

          <section className="blueprint-selection">
            <div className="blueprint-selection__heading">
              <h2>Machine type</h2>
              <p>Select the compute location and size for this workspace.</p>
            </div>
            {loading ? (
              <OutlinedLoadingRows count={4} ariaLabel="Loading machine types" />
            ) : machines.length > 0 ? (
              <MachineCatalogGrid
                machines={machines}
                selectedMachineType={selectedMachineType}
                onSelect={setSelectedMachineType}
              />
            ) : (
              <div className="blueprint-selection__empty">No machine types are available.</div>
            )}
          </section>

          <section className="blueprint-selection">
            <div className="blueprint-selection__heading">
              <h2>Volume</h2>
              <p>Optionally attach an available volume.</p>
            </div>
            <label className="blueprint-field">
              Volume
              <select name="volumeId" defaultValue="" disabled={!supportsVolumes}>
                <option value="">No volume</option>
                {volumes.map((volume) => (
                  <option key={volume.id} value={volume.id} disabled={volume.status !== 'available'}>
                    {volume.name} · {volume.sizeGb} GB · {volume.location} · {volume.status}
                  </option>
                ))}
              </select>
              {!supportsVolumes && selectedMachine !== undefined && (
                <span>Volumes are not supported by this machine provider.</span>
              )}
            </label>
          </section>

          <section className="blueprint-selection blueprint-setup-script">
            <div className="blueprint-selection__heading">
              <h2>SSH public key (optional)</h2>
              <p>Optional. Without a key the workspace is cockpit-only. Recreate the workspace to add one later.</p>
            </div>
            <textarea
              name="sshPublicKey"
              aria-label="SSH public key (optional)"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </section>
        </div>

        <footer className="create-workspace-actions">
          <button className="blueprint-cancel" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button
            className="create-workspace-primary"
            type="submit"
            disabled={busy || loading || selectedMachineType === ''}
          >
            {busy ? 'Creating…' : 'Create workspace'}
          </button>
        </footer>
      </form>
    </div>
  );
}
