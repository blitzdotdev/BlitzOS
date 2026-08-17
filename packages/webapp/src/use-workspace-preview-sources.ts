import { useEffect, useReducer } from 'react';
import {
  fetchWorkspacePorts,
  fetchWorkspacePreviews,
  initialPortsState,
  PORTS_POLL_INTERVAL_MS,
  portsReducer,
  type LivePort,
  type PreviewLink,
} from './preview';

export type WorkspacePreviewSources = {
  livePorts: LivePort[];
  previewLinks: PreviewLink[];
};

export function useWorkspacePreviewSources(
  enabled: boolean,
  workspaceId: string,
  filesBase: string | null,
): WorkspacePreviewSources {
  const [state, dispatch] = useReducer(portsReducer, initialPortsState);

  useEffect(() => {
    dispatch({ type: 'reset', workspaceId });
  }, [workspaceId]);

  useEffect(() => {
    if (!enabled || filesBase === null || workspaceId === '') return;
    let disposed = false;
    let request: AbortController | null = null;
    const poll = async () => {
      if (request !== null || document.visibilityState !== 'visible') return;
      request = new AbortController();
      const current = request;
      const [ports, previews] = await Promise.all([
        fetchWorkspacePorts(filesBase, fetch, current.signal),
        fetchWorkspacePreviews(filesBase, fetch, current.signal),
      ]);
      if (!disposed && request === current && !current.signal.aborted) {
        dispatch({ type: 'received', workspaceId, ports, previews, now: Date.now() });
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
