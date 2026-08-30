import { useEffect, useState } from 'react';
import type { OrgUsageCaptureResponse } from '@blitzos/schema';
import type { ControlPlaneClient } from '../api';
import { folderPagePath } from '../sessions-page-state';

/** Admin switch for org-wide agent-usage capture. While it is on, every
 * workspace mirrors its agents' native transcripts into an admin-only Drive
 * folder the control plane lazy-creates on first enable; the response carries
 * the folder id, so the panel reflects exactly what the server did. */
export function UsagePanel({ client }: { client: ControlPlaneClient }) {
  const [state, setState] = useState<OrgUsageCaptureResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void client.getUsageCapture()
      .then((loaded) => {
        if (mounted) setState(loaded);
      })
      .catch((caught: Error) => {
        if (mounted) setError(caught.message);
      });
    return () => { mounted = false; };
  }, [client]);

  const toggle = (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void client.putUsageCapture(enabled)
      .then(setState)
      .catch((caught: Error) => setError(caught.message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="settings-panel" role="tabpanel" aria-label="Usage">
      <header className="settings-panel-header"><div><p>Organization</p><h1>Agent usage capture</h1><span>Collect every workspace&rsquo;s agent transcripts for evals.</span></div></header>
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      {state === null ? (
        !error && <div className="drive-empty" role="status">Loading…</div>
      ) : (
        <>
          <label className="tplf-share">
            <input
              type="checkbox"
              role="switch"
              aria-label="Agent usage capture"
              checked={state.enabled}
              disabled={busy}
              onChange={(event) => toggle(event.currentTarget.checked)}
            />
            <span>
              Capture agent usage across the organization. Workspaces mirror
              their agents&rsquo; native transcripts into an admin-only Drive
              folder, grouped per workspace. Members&rsquo; workspaces never see
              the folder.
            </span>
          </label>
          <p className="cfg-help" role="status">
            {state.enabled
              ? 'Capture is on. New workspace activity syncs into the usage folder.'
              : state.folderId === null
                ? 'Capture is off. The usage folder is created the first time you turn it on.'
                : 'Capture is off. The usage folder and everything already collected are kept.'}
          </p>
          {state.folderId !== null && (
            <p className="cfg-help">
              <a href={folderPagePath(state.folderId)}>Open the usage folder in Drive</a>
              {' — share it explicitly to grant access; it has no org-wide role.'}
            </p>
          )}
        </>
      )}
    </section>
  );
}
