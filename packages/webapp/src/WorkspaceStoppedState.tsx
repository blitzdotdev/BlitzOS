import { useState } from 'react';
import { caughtErrorMessage } from './error-message';

/**
 * What the main pane shows while the viewer's own machine in this workspace is
 * STOPPED (`workspace-store.ts`, `lifecycleStatusFor`).
 *
 * A stopped machine keeps its disk and its row, and `start` is a member's own
 * verb (plans/MEMBER-MACHINES.md §3), so the pane offers it here rather than
 * sending the member to the "My machine" dialog to find it. It replaces the
 * loading pane, which used to spin over a box the shell was dialling for
 * nothing: every call answered 409 until the member opened that dialog by
 * luck. Nothing is dialled while this is on screen.
 */
export function WorkspaceStoppedState({
  workspaceName,
  onStart,
}: {
  workspaceName: string;
  /** Starts the viewer's machine; the poll then carries the pane through
   * `creating` to `running`. */
  onStart: () => Promise<void>;
}) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const start = async () => {
    if (starting) return;
    setStarting(true);
    setStartError(null);
    try {
      await onStart();
    } catch (cause) {
      setStartError(caughtErrorMessage(cause, 'The machine could not be started.'));
      setStarting(false);
    }
  };

  return (
    <div className="webapp-empty workspace-stopped-state" role="status">
      <h1>Your machine in {workspaceName} is stopped</h1>
      <p>Its disk is kept. Start it to open terminals and sessions here again.</p>
      <button
        className="webapp-action webapp-action--primary"
        type="button"
        disabled={starting}
        onClick={() => { void start(); }}
      >{starting ? 'Starting…' : 'Start machine'}</button>
      {startError && <p className="workspace-stopped-state__error" role="alert">{startError}</p>}
    </div>
  );
}
