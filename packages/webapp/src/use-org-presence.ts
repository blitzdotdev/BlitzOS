import {
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  PRESENCE_HIDDEN_POLL_INTERVAL_MS,
  PRESENCE_VISIBLE_POLL_INTERVAL_MS,
  type PresenceSnapshotResponse,
  type PutPresenceConnectionRequest,
} from '@blitzos/schema';
import { useEffect, useMemo, useState } from 'react';

const PRESENCE_CLIENT_ID_KEY = 'blitz:presence-client-id:v1';
const MAX_RETRY_MS = 30_000;

type PresenceView = Pick<
  PutPresenceConnectionRequest,
  'workspaceId' | 'surfaces' | 'focusedSurface'
>;

export interface PresenceApi {
  putPresenceConnection(clientId: string, input: PutPresenceConnectionRequest): Promise<void>;
  deletePresenceConnection(clientId: string, keepalive?: boolean): Promise<void>;
  getPresence(): Promise<PresenceSnapshotResponse>;
}

function newClientId(): string {
  return crypto.randomUUID();
}

export function presenceClientId(): string {
  try {
    const stored = sessionStorage.getItem(PRESENCE_CLIENT_ID_KEY);
    if (stored !== null && /^[A-Za-z0-9_-]{1,128}$/u.test(stored)) return stored;
    const created = newClientId();
    sessionStorage.setItem(PRESENCE_CLIENT_ID_KEY, created);
    return created;
  } catch {
    return newClientId();
  }
}

function jitter(maximum: number): number {
  return Math.floor(Math.random() * maximum);
}

function retryDelay(failures: number): number {
  return Math.min(MAX_RETRY_MS, 1_000 * (2 ** Math.min(failures - 1, 5))) + jitter(500);
}

function liveDocumentState(): Pick<PutPresenceConnectionRequest, 'visible' | 'focused'> {
  const visible = document.visibilityState === 'visible';
  return { visible, focused: visible && document.hasFocus() };
}

export function useOrgPresence(
  api: PresenceApi,
  enabled: boolean,
  view: PresenceView,
): PresenceSnapshotResponse | null {
  const [snapshot, setSnapshot] = useState<PresenceSnapshotResponse | null>(null);
  const clientId = useMemo(presenceClientId, []);
  const viewKey = JSON.stringify(view);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer = 0;
    let inFlight = false;
    let pending = false;
    let failures = 0;

    const schedule = (delay: number): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void report(); }, delay);
    };
    const report = async (): Promise<void> => {
      if (!active) return;
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      try {
        await api.putPresenceConnection(clientId, { ...view, ...liveDocumentState() });
        failures = 0;
        if (active) schedule(PRESENCE_HEARTBEAT_INTERVAL_MS + jitter(1_000));
      } catch {
        failures += 1;
        if (active) schedule(retryDelay(failures));
      } finally {
        inFlight = false;
        if (active && pending) {
          pending = false;
          void report();
        }
      }
    };
    const reportNow = (): void => { void report(); };
    void report();
    window.addEventListener('focus', reportNow);
    window.addEventListener('blur', reportNow);
    window.addEventListener('pageshow', reportNow);
    document.addEventListener('visibilitychange', reportNow);
    return () => {
      active = false;
      window.clearTimeout(timer);
      window.removeEventListener('focus', reportNow);
      window.removeEventListener('blur', reportNow);
      window.removeEventListener('pageshow', reportNow);
      document.removeEventListener('visibilitychange', reportNow);
    };
  }, [api, clientId, enabled, viewKey]);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      return;
    }
    let active = true;
    let timer = 0;
    let inFlight = false;
    let pending = false;
    let failures = 0;

    const schedule = (delay: number): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void poll(); }, delay);
    };
    const poll = async (): Promise<void> => {
      if (!active) return;
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      try {
        const next = await api.getPresence();
        failures = 0;
        if (active) {
          setSnapshot(next);
          schedule(document.visibilityState === 'visible'
            ? PRESENCE_VISIBLE_POLL_INTERVAL_MS + jitter(500)
            : PRESENCE_HIDDEN_POLL_INTERVAL_MS + jitter(1_000));
        }
      } catch {
        failures += 1;
        if (active) schedule(retryDelay(failures));
      } finally {
        inFlight = false;
        if (active && pending) {
          pending = false;
          void poll();
        }
      }
    };
    const pollNow = (): void => { void poll(); };
    void poll();
    window.addEventListener('focus', pollNow);
    window.addEventListener('pageshow', pollNow);
    document.addEventListener('visibilitychange', pollNow);
    return () => {
      active = false;
      window.clearTimeout(timer);
      window.removeEventListener('focus', pollNow);
      window.removeEventListener('pageshow', pollNow);
      document.removeEventListener('visibilitychange', pollNow);
    };
  }, [api, enabled, viewKey]);

  useEffect(() => {
    if (!enabled) return;
    const disconnect = (): void => {
      void api.deletePresenceConnection(clientId, true).catch(() => undefined);
    };
    window.addEventListener('pagehide', disconnect);
    window.addEventListener('beforeunload', disconnect);
    return () => {
      window.removeEventListener('pagehide', disconnect);
      window.removeEventListener('beforeunload', disconnect);
      void api.deletePresenceConnection(clientId).catch(() => undefined);
    };
  }, [api, clientId, enabled]);

  return snapshot;
}
