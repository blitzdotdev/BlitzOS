import type { SpawnSessionType } from '../NewTabMenu';
import { SessionTypeIcon } from '../SessionTypeIcon';
import type { LivePort, PreviewLink } from '../preview';
import type { CloudWorkspaceModel } from '../workspace-store';
// The Drive page's own share icon, so one glyph means "share" everywhere.
import { BoxGlyph, ShareGlyph } from '../files/DriveIcons';
import { NewTabControl } from './NewTabControl';
import type { DriveRailSession } from './rail-sessions';

export type SessionRailProps = {
  workspace: CloudWorkspaceModel | undefined;
  sessions: DriveRailSession[];
  activeSessionId: string;
  livePorts: LivePort[];
  previewLinks: PreviewLink[];
  /**
   * The vendored zone (plans/LODY-SESSIONS.md §0.3).
   *
   * When supplied, `div.session-list` becomes a PORTAL TARGET and the rail draws
   * neither the `New tab` bar nor a single row: Lody's own `LoroSidebar` body
   * renders there instead, mounted by `SessionSurface` so it shares the one
   * runtime. Its header and footer are suppressed through the props phase 4
   * added upstream, its Chats and GitHub Worktrees sections come from the
   * daemon, and today's terminal rows go in through its
   * `afterSessionListContent` slot. `div.shell-rhead` above it stays native and
   * byte-for-byte unchanged either way.
   *
   * A ref rather than a `ReactNode`, because the mount has to be a CHILD of the
   * surface's provider stack and this rail is not: what crosses the boundary is
   * the host element, not an element tree.
   *
   * Absent — which is every build with `VITE_BLITZ_LODY_SESSIONS` off — the rail
   * is exactly what it was: New tab, then one row per managed tab.
   */
  onVendorHost?: (node: HTMLDivElement | null) => void;
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
 * workspace head, and below it either the vendored session sections or — with
 * Lody sessions off — the pinned New tab action and one row per managed tab.
 * A native row is gutter · title · time, and never more; the time slot stays
 * empty until a tab gets a clock. */
export function SessionRail({
  workspace,
  sessions,
  activeSessionId,
  livePorts,
  previewLinks,
  onVendorHost,
  onSelectSession,
  onSpawnSession,
  onOpenPreview,
  onOpenPreviewLink,
  onOpenMembers,
  onOpenDetails,
  onOpenMachine,
}: SessionRailProps) {
  if (workspace === undefined) {
    return (
      <aside className="session-rail" aria-label="Workspace sessions rail">
        <div className="shell-rhead"><b>No workspace</b></div>
      </aside>
    );
  }

  const canShare = workspace.accessRole === 'owner' || workspace.accessRole === 'admin';
  const vendored = onVendorHost !== undefined;
  return (
    <aside className="session-rail" aria-label="Workspace sessions rail">
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

      {!vendored && (
        <NewTabControl
          variant="bar"
          livePorts={livePorts}
          previewLinks={previewLinks}
          onSpawnSession={onSpawnSession}
          onOpenPreview={onOpenPreview}
          onOpenPreviewLink={onOpenPreviewLink}
        />
      )}

      <div
        className={`session-list${vendored ? ' session-list--vendor' : ''}`}
        role="group"
        aria-label={`Sessions in ${workspace.title}`}
        ref={onVendorHost}
      >
        {vendored ? null : sessions.map((session, index) => {
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
