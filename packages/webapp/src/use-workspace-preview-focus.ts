import { useEffect, useRef } from 'react';
import {
  fetchWorkspacePreviewFocus,
  PORTS_POLL_INTERVAL_MS,
  type PreviewFocus,
  type PreviewFocusResult,
} from './preview';

/** Polls the box's `/preview-focus` marker on the ports cadence, while the tab
 * is visible, and calls `onFocus` at most once per focus the in-box agent
 * raises with `blitz preview open` (newest `requestedAt` wins).
 *
 * Entering a workspace adopts whatever focus the box already reports as the
 * consumed baseline and never opens it, so a workspace switch — or a return —
 * cannot replay an old focus; only a strictly-newer focus that arrives while
 * the workspace is on screen opens. Only a poll that actually reached the box
 * may set that baseline. The baseline is ephemeral (a ref), never persisted to
 * webApp-state. */
export function useWorkspacePreviewFocus(
  enabled: boolean,
  workspaceId: string,
  filesBase: string | null,
  onFocus: (focus: PreviewFocus) => void,
): void {
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const consumedRef = useRef<{ workspaceId: string; requestedAt: number | null }>({
    workspaceId: '',
    requestedAt: null,
  });

  useEffect(() => {
    if (!enabled || filesBase === null || workspaceId === '') return;
    let disposed = false;
    let request: AbortController | null = null;
    const consume = (result: PreviewFocusResult) => {
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
      const result = await fetchWorkspacePreviewFocus(filesBase, fetch, current.signal);
      if (!disposed && request === current && !current.signal.aborted) {
        consume(result);
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
}
