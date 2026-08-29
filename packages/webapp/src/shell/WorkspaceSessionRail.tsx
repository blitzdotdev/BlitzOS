import { useEffect, useState } from 'react';
import {
  SessionTypeIcon,
  SPAWN_SESSION_LABELS,
  type SpawnSessionType,
} from '../WebAppHeader';
import { NATIVE_CHAT_ENABLED } from '../product-features';
import type { CloudWorkspaceModel } from '../workspace-store';
import type { DriveRailSession } from './rail-sessions';
import { PlusGlyph, ShareGlyph } from './StripIcons';

/** The same list the tab strip's "+" offers, from the same source of truth, so
 * the rail's pinned action and the strip's plus can never drift apart. */
const SPAWN_SESSION_TYPES: SpawnSessionType[] = [
  ...(NATIVE_CHAT_ENABLED ? ['chat' as const] : []),
  'claude',
  'codex',
  'terminal',
];

export type WorkspaceSessionRailProps = {
  workspace: CloudWorkspaceModel | undefined;
  sessions: DriveRailSession[];
  activeSessionId: string;
  onSelectSession: (sessionId: string) => void;
  onSpawnSession: (type: SpawnSessionType) => void;
  onOpenShare: (workspaceId: string) => void;
  onOpenDetails: (workspaceId: string) => void;
};

/** Column two of the shell (plans/mockups/session-rail.html `#rail`): the
 * workspace head, the pinned New session action, and one row per managed tab.
 * The row is gutter · title · time, and never more — the time slot stays empty
 * until Build 2 gives a session a clock. */
export function WorkspaceSessionRail({
  workspace,
  sessions,
  activeSessionId,
  onSelectSession,
  onSpawnSession,
  onOpenShare,
  onOpenDetails,
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
            aria-label={`Share ${workspace.title}`}
            title={`Share ${workspace.title}`}
            onClick={() => onOpenShare(workspace.id)}
          ><ShareGlyph className="shell-ib__glyph" /></button>
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
          aria-label="New session"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="shell-g"><PlusGlyph className="shell-new__plus" /></span>
          New session
        </button>
        {menuOpen && (
          <button
            className="webapp-org-backdrop"
            type="button"
            aria-label="Close new session menu"
            tabIndex={-1}
            onMouseDown={() => setMenuOpen(false)}
          />
        )}
        {menuOpen && (
        <div className="webapp-agent-menu shell-newmenu" role="menu" aria-label="New session types">
          {SPAWN_SESSION_TYPES.map((agent) => (
            <button
              type="button"
              role="menuitem"
              key={agent}
              onClick={() => {
                setMenuOpen(false);
                onSpawnSession(agent);
              }}
            >
              <SessionTypeIcon type={agent} className="webapp-new-menu-icon" />
              {SPAWN_SESSION_LABELS[agent]}
            </button>
          ))}
        </div>
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
