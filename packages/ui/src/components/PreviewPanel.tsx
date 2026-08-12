import type { WorkspaceView } from "@blitzos/schema";
import { useState } from "react";
import type { EndpointResolver } from "../resolver.js";
import { validPort } from "../resolver.js";

export function PreviewPanel({
  workspace,
  resolver,
}: {
  workspace: WorkspaceView;
  resolver: EndpointResolver;
}): React.JSX.Element {
  const [rawPort, setRawPort] = useState("3000");
  const port = Number(rawPort);
  const valid = validPort(port);

  return (
    <section className="panel preview-panel">
      <div className="panel-toolbar">
        <label>
          Port
          <input
            aria-label="Preview port"
            type="number"
            min="1"
            max="65535"
            value={rawPort}
            onChange={(event) => setRawPort(event.currentTarget.value)}
          />
        </label>
        {!valid && <span className="form-error">Enter a port from 1 to 65535.</span>}
      </div>
      {valid && <iframe title={`Preview on port ${port}`} src={resolver.previewUrl(workspace, port)} />}
    </section>
  );
}
