import type { WorkspaceTabs } from './storage';
import { hasObjectType, isDefined, isNumber, isString } from './type-guards';

export const PORTS_POLL_INTERVAL_MS = 5_000;

export type LivePort = {
  port: number;
  process: string;
  firstSeenAt: number;
};

export type PortsState = {
  workspaceId: string;
  ports: LivePort[];
  newPorts: LivePort[];
  removedPorts: LivePort[];
  revision: number;
};

export type PortsAction =
  | { type: 'reset'; workspaceId: string }
  | {
      type: 'received';
      workspaceId: string;
      ports: Array<{ port: number; process: string }>;
      now: number;
    };

export const initialPortsState: PortsState = {
  workspaceId: '',
  ports: [],
  newPorts: [],
  removedPorts: [],
  revision: 0,
};

export function isPreviewPort(port: number): boolean {
  return Number.isInteger(port)
    && port >= 1_024
    && port <= 65_535
    && (port < 7_443 || port > 7_446);
}

function parsedPorts(value: unknown): Array<{ port: number; process: string }> {
  if (!value || !hasObjectType(value)) return [];
  // SAFETY: The preceding check establishes a non-null object; only the optional ports field is read.
  const ports = (value as { ports?: unknown }).ports;
  if (!Array.isArray(ports)) return [];
  const seen = new Set<number>();
  return ports.flatMap((value): Array<{ port: number; process: string }> => {
    if (!value || !hasObjectType(value)) return [];
    // SAFETY: The preceding check establishes a non-null object; individual fields are validated below.
    const entry = value as { port?: unknown; process?: unknown };
    if (
      !isNumber(entry.port)
      || !isPreviewPort(entry.port)
      || !isString(entry.process)
      || seen.has(entry.port)
    ) return [];
    seen.add(entry.port);
    return [{ port: entry.port, process: entry.process }];
  }).sort((left, right) => left.port - right.port);
}

function httpUrl(value: string): URL {
  const target = new URL(value);
  if (target.protocol === 'wss:') target.protocol = 'https:';
  if (target.protocol === 'ws:') target.protocol = 'http:';
  return target;
}

function gatewayPath(filesBase: URL): string {
  const workspaceSuffix = 'workspace/';
  return filesBase.pathname.endsWith(workspaceSuffix)
    ? filesBase.pathname.slice(0, -workspaceSuffix.length)
    : '/';
}

export function portsEndpointUrl(filesBase: string): string {
  const target = httpUrl(filesBase);
  target.pathname = `${gatewayPath(target)}ports`;
  target.search = '';
  target.hash = '';
  return target.toString();
}

export async function fetchWorkspacePorts(
  filesBase: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Array<{ port: number; process: string }>> {
  try {
    const response = await fetcher(portsEndpointUrl(filesBase), {
      credentials: 'include',
      signal,
    });
    if (!response.ok) return [];
    // SAFETY: The explicit unknown assertion prevents Response.json's ambient any from bypassing parsedPorts validation.
    return parsedPorts(await response.json() as unknown);
  } catch {
    return [];
  }
}

export function portsReducer(state: PortsState, action: PortsAction): PortsState {
  if (action.type === 'reset') {
    if (state.workspaceId === action.workspaceId && state.ports.length === 0) return state;
    return {
      workspaceId: action.workspaceId,
      ports: [],
      newPorts: [],
      removedPorts: [],
      revision: state.revision + 1,
    };
  }
  if (state.workspaceId !== action.workspaceId) return state;

  const previous = new Map(state.ports.map((entry) => [entry.port, entry]));
  const ports = action.ports.map((entry) => {
    const existing = previous.get(entry.port);
    return {
      ...entry,
      firstSeenAt: existing?.firstSeenAt ?? action.now,
    };
  });
  const unchanged = ports.length === state.ports.length && ports.every((entry, index) => {
    const current = state.ports[index];
    return current?.port === entry.port
      && current.process === entry.process
      && current.firstSeenAt === entry.firstSeenAt;
  });
  if (unchanged) return state;
  return {
    ...state,
    ports,
    newPorts: ports.filter(({ port }) => !previous.has(port)),
    removedPorts: state.ports.filter(
      ({ port }) => !ports.some((entry) => entry.port === port),
    ),
    revision: state.revision + 1,
  };
}

export function newestPorts(ports: LivePort[]): LivePort[] {
  return [...ports].sort((left, right) => (
    right.firstSeenAt - left.firstSeenAt || right.port - left.port
  ));
}

export function newestUndismissedPort(
  ports: LivePort[],
  dismissed: ReadonlySet<number>,
): LivePort | null {
  return newestPorts(ports).find(({ port }) => !dismissed.has(port)) ?? null;
}

export function previewUrl(
  filesBase: string,
  port: number,
  path = '/',
  query = '',
): string {
  const target = httpUrl(filesBase);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  target.pathname = `${gatewayPath(target)}preview/${port}${normalizedPath}`;
  target.search = query;
  target.hash = '';
  return target.toString();
}

export function previewPortFromLocalUrl(href: string): number | null {
  try {
    const target = new URL(
      href,
      !isDefined(globalThis.window) ? 'http://localhost/' : window.location.href,
    );
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    const localhost = target.hostname === 'localhost' || target.hostname === '127.0.0.1';
    if (!localhost || !target.port) return null;
    const port = Number(target.port);
    return isPreviewPort(port) ? port : null;
  } catch {
    return null;
  }
}

export function openPreviewTab(tabs: WorkspaceTabs, port: number): WorkspaceTabs {
  const existing = tabs.tabs.find((tab) => tab.type === 'preview' && tab.port === port);
  if (existing) {
    return tabs.activeId === existing.id ? tabs : { ...tabs, activeId: existing.id };
  }
  const id = tabs.nextId;
  return {
    ...tabs,
    tabs: [...tabs.tabs, { id, type: 'preview', port }],
    activeId: id,
    nextId: id + 1,
  };
}
