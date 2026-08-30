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
import { LODY_DEV_ORIGIN, lodySessionsRequested } from './lody/flag';
import { FILES_DAV_ROOT } from './resolver';
import { initTheme } from './theme';

initTheme();

const root = document.getElementById('root');
if (root === null) throw new Error('Missing root element');

if (lodySessionsRequested(window.location.hash) && LODY_DEV_ORIGIN !== '') {
  // The standalone session surface, for local development against a box with
  // no control plane in front of it (plans/LODY-SESSIONS.md phase 3):
  //
  //   VITE_BLITZ_LODY_SESSIONS=true VITE_BLITZ_LODY_DEV_ORIGIN=http://127.0.0.1:PORT \
  //     npm run dev -w @blitzos/webapp        # then open /#lody
  //
  // Inside a real workspace the surface mounts through `CloudApp` instead, on
  // the same hash and the same flag. Both need the dynamic import: no part of
  // the vendored renderer may enter the entry bundle, and phase 0 measured that
  // it does not.
  void import('./lody/SessionSurface').then(({ SessionSurface }) => {
    const origin = LODY_DEV_ORIGIN.replace(/\/+$/u, '');
    createRoot(root).render(
      <StrictMode>
        <SessionSurface
          endpoints={{
            syncUrl: `${origin.replace(/^http(s?):\/\//u, 'ws$1://')}/lody/sync`,
            rpcUrl: `${origin}/lody/rpc`,
            controlUrl: `${origin}/lody/control`,
            projectUrl: `${origin}/lody/project`,
            platformUrl: `${origin}/lody/platform`,
            filesBase: `${origin}${FILES_DAV_ROOT}/`,
          }}
          viewer={{ name: 'Developer', avatarUrl: null }}
          workspaceTitle="Lody dev"
        />
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
