import type { CreateWorkspaceRequest, MachineType, Volume } from "@blitzos/schema";
import { useRef, useState } from "react";

export function CreateWorkspaceForm({
  machineTypes,
  volumes,
  loading,
  onCreate,
  onCancel,
}: {
  machineTypes: readonly MachineType[];
  volumes: readonly Volume[];
  loading: boolean;
  onCreate: (request: CreateWorkspaceRequest) => Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  const [pending, setPending] = useState<CreateWorkspaceRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);

  const review = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const machineTypeId = String(data.get("machineTypeId") ?? "");
    const sshPublicKey = String(data.get("sshPublicKey") ?? "").trim();
    const volumeId = String(data.get("volumeId") ?? "");
    const userData = String(data.get("userData") ?? "");
    if (machineTypeId.length === 0 || sshPublicKey.length === 0) return;
    setPending({
      machineTypeId,
      sshPublicKey,
      ...(volumeId.length > 0 ? { volumeId } : {}),
      ...(userData.length > 0 ? { userData } : {}),
    });
    submittedRef.current = false;
    setError(null);
  };

  const confirm = async (): Promise<void> => {
    if (pending === null || submittedRef.current) return;
    submittedRef.current = true;
    setSubmitting(true);
    try {
      await onCreate(pending);
      setPending(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Create failed.");
      setPending(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="create-panel card" aria-label="Create workspace">
      <div className="section-heading">
        <div><p className="eyebrow">New workspace</p><h2>Create</h2></div>
        <button className="cockpit-action" type="button" onClick={onCancel}>Close</button>
      </div>
      {loading ? (
        <p className="loading-state has-spinner">Loading machine types and volumes…</p>
      ) : (
        <form className="stack-form" onSubmit={review}>
          <label>
            Machine type
            <select name="machineTypeId" required defaultValue="">
              <option value="" disabled>Select a machine</option>
              {machineTypes.map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {machine.name} · {machine.cpuCores} CPU · {machine.memGb} GiB · {machine.location}
                </option>
              ))}
            </select>
          </label>
          <label>
            Volume
            <select name="volumeId" defaultValue="">
              <option value="">No volume</option>
              {volumes.map((volume) => (
                <option key={volume.id} value={volume.id} disabled={volume.status !== "available"}>
                  {volume.name} · {volume.sizeGb} GiB · {volume.status}
                </option>
              ))}
            </select>
          </label>
          <label>
            SSH public key
            <textarea name="sshPublicKey" rows={4} required spellCheck={false} />
          </label>
          <label>
            User-data <span className="muted">optional</span>
            <textarea name="userData" rows={7} spellCheck={false} />
          </label>
          <p className="cockpit-form-message warning">the VM can read user-data; never put secrets in it</p>
          {error !== null && <p className="cockpit-form-message form-error">{error}</p>}
          <div className="button-row">
            <button className="cockpit-action" type="button" onClick={onCancel}>Cancel</button>
            <button className="cockpit-action cockpit-action--primary" type="submit">Review create</button>
          </div>
        </form>
      )}
      {pending !== null && (
        <div className="modal-backdrop" role="presentation">
          <div className="card modal" role="dialog" aria-modal="true" aria-label="Confirm workspace creation">
            <h2>Create this workspace?</h2>
            <p>One confirmation sends one create request.</p>
            <div className="button-row">
              <button className="cockpit-action" type="button" disabled={submitting} onClick={() => setPending(null)}>Cancel</button>
              <button className="cockpit-action cockpit-action--primary" type="button" disabled={submitting} onClick={() => void confirm()}>
                {submitting && <span className="cockpit-inline-spinner" />}
                {submitting ? "Creating…" : "Confirm create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
