import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@vscode/codicons/dist/codicon.css';
import '@xterm/xterm/css/xterm.css';
import './tokens.css';
import './webapp-icons.css';
import './webapp-base.css';
import './webapp-shell.css';
import './webapp-workspace.css';
import './webapp-select.css';
import './files-drive.css';
import './drive-shell.css';
import './strip-rail.css';
import './files.css';
import './confirmation-dialog.css';
import './workspace-details-dialog.css';
import './loading-skeleton.css';
import './create-workspace-dialog.css';
import './settings.css';
import './invite-redeem.css';
import { StandaloneWebApp } from './StandaloneWebApp';
import { lodySpikeRequested } from './lody/flag';
import { initTheme } from './theme';

initTheme();

const root = document.getElementById('root');
if (root === null) throw new Error('Missing root element');

if (lodySpikeRequested(window.location.hash)) {
  // Phase-0 render spike (plans/LODY-SESSIONS.md §10). Behind
  // LODY_SESSIONS_ENABLED, which is off unless a developer sets
  // VITE_BLITZ_LODY_SESSIONS=true, and reached only at #lody-spike.
  //
  // The import stays dynamic so the vendored Lody renderer is a lazy chunk:
  // no part of it may enter the entry bundle, and phase 0 measures that.
  void import('./lody/SessionSurfaceSpike').then(({ SessionSurfaceSpike }) => {
    createRoot(root).render(
      <StrictMode>
        <SessionSurfaceSpike />
      </StrictMode>,
    );
  });
} else {
  createRoot(root).render(
    <StrictMode>
      <StandaloneWebApp controlPlaneBaseUrl={import.meta.env.VITE_CONTROL_PLANE_URL} />
    </StrictMode>,
  );
}
