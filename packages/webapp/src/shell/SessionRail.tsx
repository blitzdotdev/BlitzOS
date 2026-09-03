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
   * runtime. Its header is suppressed through the prop phase 4 added upstream,
   * its footer is cut down to Archive plus our New tab control (seam patches
   * 13 and 18), and its Chats and GitHub Worktrees sections come from the
   * daemon. `div.shell-rhead` above it stays native and byte-for-byte
   * unchanged either way.
   *
   * A ref rather than a `ReactNode`, because the mount has to be a CHILD of the
   * surface's provider stack and this rail is not: what crosses the boundary is
   * the host element, not an element tree.
   *
   * Absent — which is every build with `VITE_BLITZ_LODY_SESSIONS` off — the rail
   * is exactly what it was: New tab, then one row per managed tab.
   */
  onVendorHost?: (node: HTMLDivElement | null) => void;
  /**
   * The build has sessions on and this workspace's MACHINE does not serve them
   * (`lody/box-capability.ts`, plans/LODY-RUNTIME-DESIGN.md §17).
   *
   * The rail is already back to its flag-off shape by then, because
   * `onVendorHost` is absent for the same reason. This is the one line that
   * says why, so the gap reads as a machine that needs replacing rather than as
   * a feature that does not work.
   */
  sessionsNeedNewerMachine?: boolean;
  /**
   * The build has sessions on, this member holds NO machine in this workspace,
   * and so every call to the box is refused before it reaches one
   * (`lody/box-capability.ts`; the control plane's 409 in `machineForRequest`).
   *
   * The same line as `sessionsNeedNewerMachine` in every respect but its words:
   * the rail is already back to its flag-off shape, and what a member can act on
   * here is a machine that does not exist rather than one that is too old. The
   * two are mutually exclusive — one probe answers one thing — so the notice
   * renders at most once.
   */
  sessionsNeedMachine?: boolean;
  /**
   * The build has sessions on, the box's gateway answers, and the session
   * daemon behind it has not published its catalog for longer than a member
   * should wait (`lody/box-capability.ts`, `stalled`).
   *
   * The rail is back to its flag-off shape, so terminals work; the probe keeps
   * asking, so a daemon that was only slow brings the surface back by itself.
   * What a member can act on if it does not is the machine, from "My machine".
   */
  sessionsStalled?: boolean;
  onSelectSession: (sessionId: string) => void;
  /**
   * Close one tab from its row.
   *
   * The native tab strip carried the only close there was, and it is deleted
   * (plans/LODY-TERMINAL-TABS.md §4.6, "PR 2"). This rail is what a box with no
   * session plane sees — an old image, or a member with no machine here — so
   * without this that member could open a terminal and never close it, and its
   * tmux session would outlive them on the box.
   */
  onCloseSession: (sessionId: string) => void;
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

/** "Recreate" is the verb the "My machine" dialog's own button carries
 * (`MyMachineDialog.tsx` `ACTION_LABELS`), so the rail uses that word and not a
 * second one for the same act. */
const RECREATE_TO_ENABLE_SESSIONS = "Recreate this workspace's machine to enable sessions";

/** The same pair one step earlier: there is no machine to recreate. "Provision"
 * is again the verb "My machine" carries (`MyMachineDialog.tsx` `ACTION_LABELS`),
 * and provisioning where no machine row exists is workspace-admin work — which
 * is why the member who cannot open that dialog is told whom to ask instead of
 * being handed a button that would only show them the same sentence. */
const PROVISION_TO_ENABLE_SESSIONS = "Open My machine to provision one";
const ASK_ADMIN_FOR_A_MACHINE = "Ask a workspace admin to provision one for you";

/** The stalled daemon's pair: the rail keeps asking the box, and the one act
 * a member has meanwhile is the machine's own Recreate, in "My machine". */
const RECREATE_TO_UNSTICK_SESSIONS = "Still checking. Open My machine to recreate it";
const ASK_ADMIN_TO_UNSTICK_SESSIONS = "Still checking. Ask a workspace admin to recreate it";

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
  sessionsNeedNewerMachine,
  sessionsNeedMachine,
  sessionsStalled,
  onSelectSession,
  onCloseSession,
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

      {sessionsNeedNewerMachine === true && (
        <div className="rail-notice" role="status">
          <span className="rail-notice__t">Sessions need a newer machine</span>
          {/* The action is a wire the rail already holds: `onOpenMachine` opens
            * "My machine", where Recreate is. A member without `canControl` has
            * no such button in the head above and no dialog to open, so they
            * get the same sentence as text. */}
          {workspace.canControl ? (
            <button
              className="rail-notice__a"
              type="button"
              onClick={() => onOpenMachine(workspace.id)}
            >{RECREATE_TO_ENABLE_SESSIONS}</button>
          ) : (
            <span className="rail-notice__d">{RECREATE_TO_ENABLE_SESSIONS}</span>
          )}
        </div>
      )}

      {sessionsNeedMachine === true && (
        <div className="rail-notice" role="status">
          <span className="rail-notice__t">You have no machine in this workspace</span>
          {workspace.canControl ? (
            <button
              className="rail-notice__a"
              type="button"
              onClick={() => onOpenMachine(workspace.id)}
            >{PROVISION_TO_ENABLE_SESSIONS}</button>
          ) : (
            <span className="rail-notice__d">{ASK_ADMIN_FOR_A_MACHINE}</span>
          )}
        </div>
      )}

      {sessionsStalled === true && (
        <div className="rail-notice" role="status">
          <span className="rail-notice__t">Sessions are not answering on this machine</span>
          {workspace.canControl ? (
            <button
              className="rail-notice__a"
              type="button"
              onClick={() => onOpenMachine(workspace.id)}
            >{RECREATE_TO_UNSTICK_SESSIONS}</button>
          ) : (
            <span className="rail-notice__d">{ASK_ADMIN_TO_UNSTICK_SESSIONS}</span>
          )}
        </div>
      )}

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
            // A `div`, because the close below is a button and a button inside
            // a button is not valid HTML. The label keeps its own button, so
            // the click target and the keyboard path do not change.
            <div
              className={`shell-s${active ? ' shell-s--on' : ''}`}
              key={session.id}
              data-session-id={session.id}
              aria-current={active ? 'page' : undefined}
            >
              <button
                className="shell-s__open"
                type="button"
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
              </button>
              {/* Time is the status at Build 2. Tabs have no clock, so the
                * slot the rail has always drawn holds the close instead. */}
              <span className="shell-s__a">
                <button
                  className="shell-s__close"
                  type="button"
                  aria-label={`Close ${session.label}`}
                  title={`Close ${session.label}`}
                  onClick={() => onCloseSession(session.id)}
                >×</button>
              </span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
