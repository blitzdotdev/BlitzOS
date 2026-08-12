import { useState } from "react";
import type { StandalonePorts } from "../resolver.js";
import { validPort } from "../resolver.js";

export function SettingsPanel({
  ports,
  onSave,
  onClose,
}: {
  ports: StandalonePorts;
  onSave: (ports: StandalonePorts) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = {
      terminal: Number(data.get("terminal")),
      acp: Number(data.get("acp")),
      files: Number(data.get("files")),
    };
    if (!validPort(next.terminal) || !validPort(next.acp) || !validPort(next.files)) {
      setError("Ports must be whole numbers from 1 to 65535.");
      return;
    }
    onSave(next);
    onClose();
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="card modal" aria-label="Local tunnel settings" onSubmit={submit}>
        <h2>Local tunnel ports</h2>
        <p>These device-local settings contain ports only.</p>
        <label>Terminal<input name="terminal" type="number" defaultValue={ports.terminal} /></label>
        <label>Chat ACP<input name="acp" type="number" defaultValue={ports.acp} /></label>
        <label>Files<input name="files" type="number" defaultValue={ports.files} /></label>
        {error !== null && <p className="form-error">{error}</p>}
        <div className="button-row">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit">Save</button>
        </div>
      </form>
    </div>
  );
}
