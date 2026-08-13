import type { WorkspaceView } from "@blitzos/schema";
import { useState } from "react";
import type { EndpointResolver } from "../resolver.js";
import { endpointTarget, validPort } from "../resolver.js";

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
  const previewUrl = valid ? resolver.previewUrl(workspace, port) : null;

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
        {previewUrl !== null && <code className="endpoint-target">{endpointTarget(previewUrl)}</code>}
      </div>
      {previewUrl !== null && <iframe title={`Preview on port ${port}`} src={previewUrl} />}
    </section>
  );
}
