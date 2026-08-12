import type { ApiError, WorkspaceView } from "@blitzos/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, type ControlPlaneClient } from "./api.js";
import { acceptWorkspace, reconcileWorkspaces } from "./reconciler.js";

const NORMAL_POLL_MS = 2_000;
const MAX_BACKOFF_MS = 16_000;

export interface WorkspacePolling {
  workspaces: WorkspaceView[];
  loading: boolean;
  error: ApiError | null;
  pollNow(): void;
  accept(workspace: WorkspaceView): void;
}

export function useWorkspaces(
  client: ControlPlaneClient,
  enabled: boolean,
  onAuthenticated: () => void,
  onUnauthorized: () => void,
): WorkspacePolling {
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const wakeRef = useRef<(() => void) | null>(null);

  const pollNow = useCallback(() => wakeRef.current?.(), []);
  const accept = useCallback((workspace: WorkspaceView) => {
    setWorkspaces((current) => acceptWorkspace(current, workspace));
  }, []);

  useEffect(() => {
    if (!enabled) {
      setWorkspaces([]);
      setLoading(false);
      setError(null);
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: AbortController | undefined;
    let failures = 0;

    const schedule = (delay: number): void => {
      timer = setTimeout(() => void poll(), delay);
      wakeRef.current = () => {
        if (timer !== undefined) clearTimeout(timer);
        void poll();
      };
    };

    const poll = async (): Promise<void> => {
      wakeRef.current = null;
      abort = new AbortController();
      try {
        const response = await client.poll(abort.signal);
        if (!active) return;
        setWorkspaces((current) => reconcileWorkspaces(current, response.workspaces));
        setError(null);
        setLoading(false);
        failures = 0;
        onAuthenticated();
        schedule(NORMAL_POLL_MS);
      } catch (caught) {
        if (!active || (caught instanceof DOMException && caught.name === "AbortError")) return;
        setLoading(false);
        failures += 1;
        if (caught instanceof ApiRequestError) {
          if (caught.status === 401) {
            onUnauthorized();
            return;
          }
          setError({ error: caught.message, retryAction: caught.retryAction });
        } else {
          setError({ error: "Unable to reach the control plane.", retryAction: null });
        }
        schedule(Math.min(1_000 * 2 ** (failures - 1), MAX_BACKOFF_MS));
      }
    };

    void poll();
    return () => {
      active = false;
      abort?.abort();
      if (timer !== undefined) clearTimeout(timer);
      wakeRef.current = null;
    };
  }, [client, enabled, onAuthenticated, onUnauthorized]);

  return { workspaces, loading, error, pollNow, accept };
}
