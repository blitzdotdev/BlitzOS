import type { ReactNode } from 'react';
import type { WorkspaceDrawerSegment } from './storage';
import { FolderIcon, GenericProviderIcon } from './WebAppIcons';

/** The right icon strip. Each icon owns one panel: clicking it splits the tab
 * area and opens that panel as a tab in the right pane, clicking it again
 * while its tab is in front closes it. */
export function WorkspaceRailStrip({
  openPanels,
  canManageCredentials,
  pendingRequestCount,
  onTogglePanel,
}: {
  openPanels: ReadonlySet<WorkspaceDrawerSegment>;
  canManageCredentials: boolean;
  pendingRequestCount: number;
  onTogglePanel: (panel: WorkspaceDrawerSegment) => void;
}) {
  const panels: Array<{
    id: WorkspaceDrawerSegment;
    label: string;
    icon: ReactNode;
  }> = [
    { id: 'files', label: 'Files', icon: <FolderIcon className="webapp-rail-strip__icon" /> },
    {
      id: 'previews',
      label: 'teenyapps',
      icon: <span className="webapp-rail-strip__icon mi-preview" aria-hidden="true" />,
    },
  ];
  if (canManageCredentials) {
    panels.push({
      id: 'connections',
      label: 'Connections',
      icon: <GenericProviderIcon className="webapp-rail-strip__icon" />,
    });
  }
  return (
    <nav className="webapp-rail-strip" aria-label="Workspace panels">
      {panels.map((panel) => {
        const open = openPanels.has(panel.id);
        return (
          <button
            className={`webapp-rail-strip__button${open ? ' webapp-rail-strip__button--open' : ''}`}
            type="button"
            key={panel.id}
            title={panel.label}
            aria-label={panel.label}
            aria-pressed={open}
            onClick={() => onTogglePanel(panel.id)}
          >
            {panel.icon}
            {panel.id === 'connections' && pendingRequestCount > 0 && (
              <span
                className="workspace-pending-badge"
                aria-label={`${pendingRequestCount} pending`}
              >{pendingRequestCount}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
