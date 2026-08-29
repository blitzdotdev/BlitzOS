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
import './chat-panel.css';
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
import { initTheme } from './theme';

initTheme();

const root = document.getElementById('root');
if (root === null) throw new Error('Missing root element');

createRoot(root).render(
  <StrictMode>
    <StandaloneWebApp controlPlaneBaseUrl={import.meta.env.VITE_CONTROL_PLANE_URL} />
  </StrictMode>,
);
