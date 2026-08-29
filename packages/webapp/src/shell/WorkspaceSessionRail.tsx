import { useEffect, useState } from 'react';
import { NewTabMenu, type SpawnSessionType } from '../NewTabMenu';
import { SessionTypeIcon } from '../SessionTypeIcon';
import type { LivePort, PreviewLink } from '../preview';
import type { CloudWorkspaceModel } from '../workspace-store';
// The Drive page's own share icon, so one glyph means "share" everywhere.
import { BoxGlyph, ShareGlyph } from '../files/DriveIcons';
import type { DriveRailSession } from './rail-sessions';
import { PlusGlyph } from './StripIcons';

export type WorkspaceSessionRailProps = {
  workspace: CloudWorkspaceModel | undefined;
  sessions: DriveRailSession[];
  activeSessionId: string;
  livePorts: LivePort[];
  previewLinks: PreviewLink[];
  onSelectSession: (sessionId: string) => void;
  onSpawnSession: (type: SpawnSessionType) => void;
  onOpenPreview: (port: number) => void;
  onOpenPreviewLink: (url: string, title: string) => void;
  /** Membership IS sharing now (plans/MEMBER-MACHINES.md §3), so this opens
   * the details dialog on its Members tab. */
  onOpenMembers: (workspaceId: string) => void;
  onOpenDetails: (workspaceId: string) => void;
  /** The member's own machine in this workspace (§2.1). */
  onOpenMachine: (workspaceId: string) => void;
};

/** Column two of the shell (plans/mockups/session-rail.html `#rail`): the
 * workspace head, the pinned New tab action, and one row per managed tab.
 * The row is gutter · title · time, and never more — the time slot stays empty
 * until Build 2 gives a session a clock. */
export function WorkspaceSessionRail({
  workspace,
  sessions,
  activeSessionId,
  livePorts,
  previewLinks,
  onSelectSession,
  onSpawnSession,
  onOpenPreview,
  onOpenPreviewLink,
  onOpenMembers,
  onOpenDetails,
  onOpenMachine,
}: WorkspaceSessionRailProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [menuOpen]);

  if (workspace === undefined) {
    return (
      <aside className="shell-rail" aria-label="Workspace sessions rail">
        <div className="shell-rhead"><b>No workspace</b></div>
      </aside>
    );
  }

  const canShare = workspace.accessRole === 'owner' || workspace.accessRole === 'admin';
  return (
    <aside className="shell-rail" aria-label="Workspace sessions rail">
      <div className="shell-rhead">
        <b title={workspace.title}>{workspace.title}</b>
        {/* The mockup's RAM readout: machines are not user-facing, so the slot
          * holds its place and waits for Build 2 to fill it. */}
        <span className="shell-rhead__sub" />
        {canShare && (
          <button
            className="shell-ib"
            type="button"
            aria-label={`Members of ${workspace.title}`}
            title={`Members of ${workspace.title}`}
            onClick={() => onOpenMembers(workspace.id)}
          ><ShareGlyph className="shell-ib__glyph" /></button>
        )}
        {workspace.canControl && (
          <button
            className="shell-ib"
            type="button"
            aria-label={`My machine in ${workspace.title}`}
            title={`My machine in ${workspace.title}`}
            onClick={() => onOpenMachine(workspace.id)}
          ><BoxGlyph className="shell-ib__glyph" /></button>
        )}
        {workspace.canControl && (
          <button
            className="shell-ib"
            type="button"
            aria-label={`Workspace details for ${workspace.title}`}
            title={`Workspace details for ${workspace.title}`}
            onClick={() => onOpenDetails(workspace.id)}
          ><span className="codicon codicon-ellipsis" aria-hidden="true" /></button>
        )}
      </div>

      <div className="shell-newbar">
        <button
          className="shell-new"
          type="button"
          aria-label="New tab"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="shell-g"><PlusGlyph className="shell-new__plus" /></span>
          New tab
        </button>
        {menuOpen && (
          <button
            className="webapp-org-backdrop"
            type="button"
            aria-label="Close new tab menu"
            tabIndex={-1}
            onMouseDown={() => setMenuOpen(false)}
          />
        )}
        {menuOpen && (
          <NewTabMenu
            className="shell-newmenu"
            livePorts={livePorts}
            previewLinks={previewLinks}
            onSpawn={(agent) => {
              setMenuOpen(false);
              onSpawnSession(agent);
            }}
            onOpenPreview={(port) => {
              setMenuOpen(false);
              onOpenPreview(port);
            }}
            onOpenPreviewLink={(url, title) => {
              setMenuOpen(false);
              onOpenPreviewLink(url, title);
            }}
          />
        )}
      </div>

      <div
        className="shell-list"
        role="group"
        aria-label={`Sessions in ${workspace.title}`}
      >
        {sessions.map((session, index) => {
          const active = session.id === activeSessionId
            || (activeSessionId === '' && index === 0);
          return (
            <button
              className={`shell-s${active ? ' shell-s--on' : ''}`}
              type="button"
              key={session.id}
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelectSession(session.id)}
            >
              <span className="shell-g">
                <SessionTypeIcon
                  type={session.agent}
                  className="shell-g__glyph"
                  filePath={session.filePath}
                />
              </span>
              <span className="shell-s__t">{session.label}</span>
              {/* Time is the status at Build 2. Tabs have no clock, so the
                * slot is drawn and left empty. */}
              <span className="shell-s__a" />
            </button>
          );
        })}
      </div>
    </aside>
  );
}
