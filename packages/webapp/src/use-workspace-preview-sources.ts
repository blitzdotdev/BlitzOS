import { useEffect, useReducer, useRef } from 'react';
import {
  fetchWorkspacePorts,
  fetchWorkspacePreviewFocus,
  fetchWorkspacePreviews,
  initialPortsState,
  PORTS_POLL_INTERVAL_MS,
  portsReducer,
  type LivePort,
  type PreviewFocus,
  type PreviewFocusResult,
  type PreviewLink,
} from './preview';

export type WorkspacePreviewSources = {
  livePorts: LivePort[];
  previewLinks: PreviewLink[];
};

/** One gateway poller for everything preview-shaped: live ports, public
 * preview links, and the `/preview-focus` marker, fetched together on the
 * same cadence while the tab is visible.
 *
 * `onPreviewFocus` fires at most once per focus the in-box agent raises with
 * `blitz preview open` (newest `requestedAt` wins). Entering a workspace
 * adopts whatever focus the box already reports as the consumed baseline and
 * never opens it, so a workspace switch — or a return — cannot replay an old
 * focus; only a strictly-newer focus that arrives while the workspace is on
 * screen opens. Only a poll that actually reached the box may set that
 * baseline. The baseline is ephemeral (a ref), never persisted to
 * webApp-state. */
export function useWorkspacePreviewSources(
  enabled: boolean,
  workspaceId: string,
  filesBase: string | null,
  onPreviewFocus: (focus: PreviewFocus) => void,
): WorkspacePreviewSources {
  const [state, dispatch] = useReducer(portsReducer, initialPortsState);
  const onFocusRef = useRef(onPreviewFocus);
  onFocusRef.current = onPreviewFocus;
  const consumedRef = useRef<{ workspaceId: string; requestedAt: number | null }>({
    workspaceId: '',
    requestedAt: null,
  });

  useEffect(() => {
    dispatch({ type: 'reset', workspaceId });
  }, [workspaceId]);

  useEffect(() => {
    if (!enabled || filesBase === null || workspaceId === '') return;
    let disposed = false;
    let request: AbortController | null = null;
    const consumeFocus = (result: PreviewFocusResult) => {
      // A poll that failed says nothing about the box's focus. Adopting its
      // empty answer as the baseline would make the next successful poll look
      // like a brand-new focus and re-open a marker from a previous visit.
      if (!result.ok) return;
      const focus = result.focus;
      if (consumedRef.current.workspaceId !== workspaceId) {
        // First successful observation after entering this workspace: adopt the
        // box's current focus as already-consumed and do not auto-open it.
        consumedRef.current = {
          workspaceId,
          requestedAt: focus === null ? null : focus.requestedAt,
        };
        return;
      }
      if (focus === null) return;
      const last = consumedRef.current.requestedAt;
      if (last !== null && focus.requestedAt <= last) return;
      consumedRef.current = { workspaceId, requestedAt: focus.requestedAt };
      onFocusRef.current(focus);
    };
    const poll = async () => {
      if (request !== null || document.visibilityState !== 'visible') return;
      request = new AbortController();
      const current = request;
      const [ports, previews, focusResult] = await Promise.all([
        fetchWorkspacePorts(filesBase, current.signal),
        fetchWorkspacePreviews(filesBase, current.signal),
        fetchWorkspacePreviewFocus(filesBase, current.signal),
      ]);
      if (!disposed && request === current && !current.signal.aborted) {
        dispatch({ type: 'received', workspaceId, ports, previews, now: Date.now() });
        consumeFocus(focusResult);
      }
      if (request === current) request = null;
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, PORTS_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      request?.abort();
      window.clearInterval(timer);
    };
  }, [enabled, filesBase, workspaceId]);

  return state.workspaceId === workspaceId
    ? { livePorts: state.ports, previewLinks: state.previews }
    : { livePorts: [], previewLinks: [] };
}
